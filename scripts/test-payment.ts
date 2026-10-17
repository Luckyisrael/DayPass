/**
 * Proves the payment-verification core is correct without spending money.
 * Signs a genuine EIP-3009 TransferWithAuthorization with a throwaway key and
 * checks that verifyPaymentProof accepts it and rejects every tampered variant.
 * Run: npx tsx scripts/test-payment.ts
 */
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  TRANSFER_WITH_AUTHORIZATION,
  USDC_DOMAIN,
  buildAccepts,
  usdToAtomic,
  verifyPaymentProof,
} from "../src/plugin/payment.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const);

const PAY_TO = "0x441035c24111a37c19e092cf13ae59d38d02985e";
const AMOUNT = usdToAtomic(0.5); // 500000

let failures = 0;
const check = (cond: boolean, label: string, detail = "") =>
  cond ? console.log(`✅ ${label}`) : (failures++, console.error(`❌ ${label} ${detail}`));

async function makeProof(overrides: Partial<Parameters<typeof buildProof>[0]> = {}) {
  return buildProof(overrides);
}

async function buildProof(opts: {
  to?: `0x${string}`;
  value?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: `0x${string}`;
  claimFrom?: `0x${string}`;
  signWith?: typeof account;
}): Promise<string> {
  const to = opts.to ?? (PAY_TO as `0x${string}`);
  const value = opts.value ?? AMOUNT;
  const validAfter = opts.validAfter ?? "0";
  const validBefore = opts.validBefore ?? String(Math.floor(Date.now() / 1000) + 3600);
  const nonce = opts.nonce ?? (keccak256(toHex(Math.random().toString())) as `0x${string}`);
  const signer = opts.signWith ?? account;
  const from = opts.claimFrom ?? signer.address;

  const message = { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
  const signature = await signer.signTypedData({
    domain: USDC_DOMAIN,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message,
  });

  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: { signature, authorization: { from, to, value, validAfter, validBefore, nonce } },
    }),
  ).toString("base64");
}

const expected = { payTo: PAY_TO, amountAtomic: AMOUNT };

// 1. A correctly signed proof is accepted, and reports the payer.
const good = await makeProof();
const ok = await verifyPaymentProof(good, expected);
check(ok.ok === true, "valid proof accepted", JSON.stringify(ok));
check(ok.ok && ok.payer.toLowerCase() === account.address.toLowerCase(), "payer recovered == signer");

// 2. Replaying the same proof must fail — a pass must never be minted twice.
const replay = await verifyPaymentProof(good, expected);
check(!replay.ok && replay.reason === "replayed", "replayed nonce rejected", JSON.stringify(replay));

// 3. Underpayment rejected.
const under = await makeProof({ value: usdToAtomic(0.1) });
const underRes = await verifyPaymentProof(under, expected);
check(!underRes.ok && underRes.reason === "insufficient_amount", "underpayment rejected", JSON.stringify(underRes));

// 4. Paying someone else rejected.
const wrongTo = await makeProof({ to: "0x000000000000000000000000000000000000dead" });
const wrongToRes = await verifyPaymentProof(wrongTo, expected);
check(!wrongToRes.ok && wrongToRes.reason === "wrong_recipient", "wrong recipient rejected", JSON.stringify(wrongToRes));

// 5. An expired authorization rejected.
const expired = await makeProof({ validBefore: String(Math.floor(Date.now() / 1000) - 60) });
const expiredRes = await verifyPaymentProof(expired, expected);
check(!expiredRes.ok && expiredRes.reason === "expired", "expired proof rejected", JSON.stringify(expiredRes));

// 6. A proof that claims someone else's `from` but is signed by an unrelated key rejected.
const victim = account.address;
const stranger = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const);
const forged = await makeProof({ claimFrom: victim, signWith: stranger });
const forgedRes = await verifyPaymentProof(forged, expected);
check(!forgedRes.ok && forgedRes.reason === "bad_signature", "forged signer rejected", JSON.stringify(forgedRes));

// 7. A proof whose signature was tampered with after signing rejected.
// Uses a fresh, never-before-seen proof so the replay check cannot mask the signature check.
const fresh = await makeProof();
const raw = JSON.parse(Buffer.from(fresh, "base64").toString("utf8"));
const flip = raw.payload.signature.slice(2);
raw.payload.signature = `0x${flip[0] === "a" ? "b" : "a"}${flip.slice(1)}`;
const tampered = Buffer.from(JSON.stringify(raw)).toString("base64");
const tamperedRes = await verifyPaymentProof(tampered, expected);
check(!tamperedRes.ok && tamperedRes.reason === "bad_signature", "tampered signature rejected", JSON.stringify(tamperedRes));

// 7b. A structurally impossible signature must be rejected, not crash the plugin.
// An all-zero signature sits off the curve, which makes viem throw instead of returning false.
const dead = JSON.parse(Buffer.from(await makeProof(), "base64").toString("utf8"));
dead.payload.signature = `0x${"00".repeat(65)}`;
const deadRes = await verifyPaymentProof(Buffer.from(JSON.stringify(dead)).toString("base64"), expected);
check(!deadRes.ok && deadRes.reason === "bad_signature", "off-curve signature rejected without throwing", JSON.stringify(deadRes));

// 8. Garbage rejected without throwing.
const garbage = await verifyPaymentProof("not-a-proof", expected);
check(!garbage.ok && garbage.reason === "malformed_proof", "malformed proof rejected", JSON.stringify(garbage));

// 9. The accepts contract we hand agents is internally consistent.
const accepts = buildAccepts({ amountUsd: 0.5, description: "t", payTo: PAY_TO });
check(accepts.maxAmountRequired === "500000", "accepts amount is 500000 atomic (0.5 USDC)");
check(accepts.network === "base" && accepts.extra.name === "USD Coin", "accepts targets USDC on Base");

if (failures > 0) {
  console.error(`\n💥 PAYMENT TEST FAILED — ${failures} assertion(s).\n`);
  process.exit(1);
}
console.log("\n🎯 PAYMENT VERIFICATION TEST PASSED\n");
