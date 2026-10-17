/**
 * Daypass demo — a real agent session, narrated. Every call below is a genuine MCP tool call or
 * a genuine HTTP request; nothing is faked except where explicitly labelled.
 *
 *   npx tsx scripts/demo.ts                    # uses a locally signed proof (wallet unfunded)
 *   npx tsx scripts/demo.ts <X-PAYMENT header> # uses a real proof from pay_x402
 *
 * Requires the server: PUBLIC_URL=... npm start
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP = process.env.DEMO_MCP_URL ?? "http://localhost:8787/mcp";
const API = process.env.DEMO_API_URL ?? "http://localhost:8787";
const OFFER = "northwind-quote-hour";
const USES_TO_SHOW = 4;

const rule = (s = "") => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);
const beat = (n: string, s: string) => rule(`BEAT ${n}  ·  ${s}`);
const show = (label: string, value: unknown) =>
  console.log(`${label}\n${JSON.stringify(value, null, 2)}\n`);

const client = new Client({ name: "daypass-demo-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP)));

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(
    (c) => c.type === "text",
  )?.text;
  if (!text) throw new Error(`no text from ${name}`);
  return JSON.parse(text) as Record<string, unknown>;
};

const { tools } = await client.listTools();
console.log(`agent connected to ${MCP}`);
console.log(`Daypass exposes ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);

beat("1", "An agent needs market data. It asks Daypass what's for sale.");
show("→ daypass_discover", await call("daypass_discover"));

beat("2", "It picks the hour pass and asks for payment terms.");
show("→ daypass_buy_pass", await call("daypass_buy_pass", { offer_id: OFFER }));

beat("3", "It pays that contract with PayBox's own pay_x402 — which is where the human's");
console.log("  passkey is raised. Daypass never touches the key or the money; it only checks the proof.");

const supplied = process.argv[2];
let proof: string;
if (supplied) {
  console.log("\n  Using the REAL proof returned by pay_x402.");
  proof = supplied;
} else {
  const { keccak256, toHex } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { USDC_DOMAIN, TRANSFER_WITH_AUTHORIZATION, usdToAtomic } = await import(
    "../src/plugin/payment.js"
  );
  // Hardhat Account #1 — a publicly documented test key that secures nothing. It signs a fake
  // local payment so the demo can run without a wallet or any real funds.
  const acct = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const to = (process.env.MERCHANT_ADDRESS ?? "0x441035c24111a37c19e092cf13ae59d38d02985e") as `0x${string}`;
  const value = usdToAtomic(0.25);
  const validAfter = "0";
  const validBefore = String(Math.floor(Date.now() / 1000) + 3600);
  const nonce = keccak256(toHex(`demo-${Date.now()}`));
  const message = {
    from: acct.address,
    to,
    value: BigInt(value),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };
  const signature = await acct.signTypedData({
    domain: USDC_DOMAIN,
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message,
  });
  proof = Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base",
      payload: { signature, authorization: { from: acct.address, to, value, validAfter, validBefore, nonce } },
    }),
  ).toString("base64");
  console.log("\n  NOTE: wallet is unfunded, so this is a locally signed proof — it proves the");
  console.log("  verification path, NOT a settled transfer. Pass a real header to make beat 3 real.");
}

const redeemed = await call("daypass_redeem", { offer_id: OFFER, x_payment: proof });
show("→ daypass_redeem", redeemed);
const passId = redeemed.pass_id as string;

beat("4", `One payment. Now ${USES_TO_SHOW} calls to the real merchant API — no further payment.`);
for (let i = 1; i <= USES_TO_SHOW; i++) {
  const res = await fetch(`${API}/v1/quotes`, { headers: { "X-Daypass-Pass": passId } });
  const body = (await res.json()) as { fx?: Array<{ pair: string; mid: number }>; observed_at?: string };
  console.log(
    `  call ${i}  HTTP ${res.status}  ·  ${body.fx?.length ?? 0} pairs  ·  EUR/USD ${body.fx?.[0]?.mid}`,
  );
}
console.log("");
show("→ daypass_status", await call("daypass_status", { pass_id: passId }));

beat("5", "Unpaid access is refused — no content leaks.");
const anon = await fetch(`${API}/v1/quotes`);
console.log(`  no pass    HTTP ${anon.status}  ${JSON.stringify(await anon.json())}`);
const bogus = await fetch(`${API}/v1/quotes`, { headers: { "X-Daypass-Pass": "not-a-pass" } });
console.log(`  bad pass   HTTP ${bogus.status}  ${JSON.stringify(await bogus.json())}`);

console.log(`\n${"═".repeat(72)}\nTHE POINT\n${"═".repeat(72)}`);
console.log("One payment bought a window of access. Each use spent one credit, the counter stayed");
console.log("honest across the API and the plugin, and unpaid requests got nothing.");
await client.close();
