/**
 * End-to-end test of the merchant's x402 surface, using Hono's in-process request harness.
 *
 * This signs a genuine EIP-3009 TransferWithAuthorization with viem and drives the whole
 * purchase: unpaid -> 402 challenge, paid -> mint, then the pass actually gating content and
 * running out. Nothing here moves real money; it proves the entitlement half, which is the
 * half Daypass owns.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

const PAY_TO = "0x441035c24111a37c19e092cf13ae59d38d02985e";
// Hardhat Account #1 — a widely published test key that secures nothing. It signs a fake
// payment locally, so the whole x402 path can be exercised end to end without moving real USDC.
const payer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

// Module-scope constants read these, so they must be set before the sources are imported.
process.env.DAYPASS_PAY_TO = PAY_TO;
process.env.PUBLIC_URL = "https://merchant.example";
process.env.DAYPASS_STORE = join(mkdtempSync(join(tmpdir(), "daypass-x402-")), "passes.json");

const { merchant } = await import("../src/merchant/routes.js");
const { USDC_DOMAIN, TRANSFER_WITH_AUTHORIZATION } = await import("../src/plugin/payment.js");

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  ok ? (pass += 1) : (fail += 1);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
};

async function proof(offerPriceAtomic: string) {
  const authorization = {
    from: payer.address,
    to: PAY_TO as `0x${string}`,
    value: BigInt(offerPriceAtomic),
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 300),
    nonce: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
  };
  const signature = await payer.signTypedData({
    domain: USDC_DOMAIN,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  const recovered = await recoverTypedDataAddress({
    domain: USDC_DOMAIN,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: authorization,
    signature,
  });
  check("the signed proof recovers to the payer", recovered === payer.address, recovered);
  // x402 carries the uint256 fields as decimal strings, which is also what our verifier
  // re-wraps with BigInt(). Serialising the BigInts directly would throw.
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: {
        signature,
        authorization: {
          from: authorization.from,
          to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    }),
  ).toString("base64");
}

const json = (r: Response) => r.json() as Promise<any>;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  merchant.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string, headers: Record<string, string> = {}) =>
  merchant.request(path, { headers: { accept: "application/json", ...headers } });

const OFFER = "northwind-quote-hour";
const PRICE = "250000"; // $0.25 in atomic USDC

console.log("merchant x402 — unpaid challenge\n");

const unpaid = await post(`/v1/passes?offer=${OFFER}`, { offerId: OFFER });
const challenge = await json(unpaid);
check("unpaid mint answers 402", unpaid.status === 402, String(unpaid.status));
check("challenge carries x402Version 1", challenge.x402Version === 1);
const accepts = challenge.accepts?.[0];
check("challenge names the exact scheme", accepts?.scheme === "exact");
check("challenge targets Base", accepts?.network === "base");
check("challenge amount matches the published offer", accepts?.maxAmountRequired === PRICE, accepts?.maxAmountRequired);
check("challenge pays to the merchant address", accepts?.payTo?.toLowerCase() === PAY_TO.toLowerCase());
check("challenge names the USDC asset", accepts?.asset?.toLowerCase().startsWith("0x833589"), accepts?.asset);
check(
  "challenge resource is the public URL, not the proxy's internal origin",
  accepts?.resource === "https://merchant.example/v1/passes?offer=northwind-quote-hour",
  accepts?.resource,
);
check("challenge declares a mime type", accepts?.mimeType === "application/json");
check(
  "the merchant's required amount equals the plugin's maxAmount, so PayBox will not reject the proposal",
  accepts?.maxAmountRequired === PRICE,
);

console.log("\nmerchant x402 — unknown offer\n");
const unknown = await post("/v1/passes", { offerId: "nope" });
check("unknown offer is a 400, not a crash", unknown.status === 400, String(unknown.status));

console.log("\nmerchant x402 — paid mint\n");
const header = await proof(PRICE);
const paid = await post(`/v1/passes?offer=${OFFER}`, { offerId: OFFER }, { "x-payment": header });
const minted = await json(paid);
check("a valid proof mints the pass", paid.status === 201, `${paid.status} ${JSON.stringify(minted)}`);
check("mint returns a pass id", typeof minted.pass_id === "string" && minted.pass_id.length > 30);
check("the pass starts with the offer's full allowance", minted.uses_remaining === 60, String(minted.uses_remaining));
check("the payer is recorded", minted.paid?.payer?.toLowerCase() === payer.address.toLowerCase());

console.log("\nmerchant x402 — replay is rejected\n");
const replay = await post(`/v1/passes?offer=${OFFER}`, { offerId: OFFER }, { "x-payment": header });
check("reusing a consumed nonce does not mint twice", replay.status === 402, String(replay.status));
check("the rejection names the replay reason", (await json(replay)).reason === "replayed");

console.log("\nmerchant x402 — a tampered amount is rejected\n");
const short = await proof("1");
const underpaid = await post(`/v1/passes?offer=${OFFER}`, { offerId: OFFER }, { "x-payment": short });
check("paying less than the offer is refused", underpaid.status === 402, String(underpaid.status));
check("the rejection names the amount", (await json(underpaid)).reason === "insufficient_amount");

console.log("\nmerchant x402 — the pass actually gates content\n");
const id: string = minted.pass_id;
const first = await get(`/v1/content/${id}`);
const firstBody = await json(first);
check("a fresh pass reads content", first.status === 200, `${first.status} ${JSON.stringify(firstBody)}`);
check("content reports the credit spent", firstBody.usesRemaining === 59, String(firstBody.usesRemaining));

const status = await get(`/v1/passes/${id}`);
const statusBody = await json(status);
check("status reports the pass as active", status.status === 200 && statusBody.status === "active");
check("status reports credits left", statusBody.uses_remaining === 59, String(statusBody.uses_remaining));

console.log("\nmerchant x402 — refusal paths\n");
const noPass = await get("/v1/quotes");
check("the protected API refuses an unpaid request", noPass.status === 401, String(noPass.status));
const bogus = await get("/v1/content/00000000-0000-4000-8000-000000000000");
check("an unknown pass is refused", bogus.status === 401, String(bogus.status));

// Exhaust the allowance and prove the gate closes — the whole point of "pay once, use many".
let finalStatus = 200;
for (let i = 0; i < 61; i += 1) {
  const r = await get(`/v1/content/${id}`);
  finalStatus = r.status;
  if (r.status !== 200) break;
}
check("the 60th use succeeds and the 601st is refused", finalStatus === 402, String(finalStatus));
const exhausted = await json(await get(`/v1/content/${id}`));
check("the refusal explains the pass is exhausted", exhausted.error === "exhausted", exhausted.error);

const unknownPass = await get(`/v1/passes/11111111-2222-4333-8444-555555555555`);
check("status of an unissued pass is a 404", unknownPass.status === 404, String(unknownPass.status));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
