/**
 * Phase 1 local gate — drives the plugin through a real MCP client, i.e. as an agent would.
 * Run: npx tsx scripts/test-mcp-client.ts [url]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] ?? "http://localhost:8787/mcp";
const READ_TOOLS = ["daypass_ping", "daypass_discover", "daypass_status"];
const WRITE_TOOLS = ["daypass_buy_pass", "daypass_redeem", "daypass_use"];
const EXPECTED_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];

let failures = 0;
const ok = (m: string) => console.log(`✅ ${m}`);
const check = (cond: boolean, m: string) => (cond ? ok(m) : (failures++, console.error(`❌ ${m}`)));

const client = new Client({ name: "daypass-test-agent", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
ok(`connected to ${url}`);

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(
    (c) => c.type === "text",
  )?.text;
  if (!text) throw new Error(`no text content from ${name}: ${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, unknown>;
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`   tools: ${JSON.stringify(names)}`);

for (const expected of EXPECTED_TOOLS) check(names.includes(expected), `tool present: ${expected}`);
check(!names.includes("daypass_echo"), "Phase 0 scaffolding removed");
for (const t of tools) {
  const shouldBeReadOnly = READ_TOOLS.includes(t.name);
  check(
    t.annotations?.readOnlyHint === shouldBeReadOnly,
    `${t.name} declares readOnlyHint:${shouldBeReadOnly}`,
  );
}

const statusSchema = tools.find((t) => t.name === "daypass_status")?.inputSchema as {
  properties?: Record<string, unknown>;
};
check("pass_id" in (statusSchema.properties ?? {}), "daypass_status declares pass_id");

check((await call("daypass_ping")).pong === true, "daypass_ping → pong:true");

const discover = await call("daypass_discover");
check(discover.status === "success", "daypass_discover → status:success");
const offers = (discover.offers ?? []) as Array<Record<string, unknown>>;
check(offers.length >= 2, `daypass_discover → ${offers.length} offers`);
for (const o of offers) {
  const w = o.window as { duration_minutes: number; max_uses: number };
  check(
    typeof o.offer_id === "string" &&
      typeof o.business === "string" &&
      typeof o.price_usd === "number" &&
      typeof o.url === "string" &&
      typeof w?.duration_minutes === "number" &&
      typeof w?.max_uses === "number",
    `offer ${o.offer_id} has the full shape`,
  );
}
console.log(`   offers: ${offers.map((o) => `${o.business} $${o.price_usd}`).join(" | ")}`);

const status = await call("daypass_status", { pass_id: "does-not-exist" });
check(status.status === "not_found", "daypass_status → not_found for an unknown pass");
check(status.pass_id === "does-not-exist", "pass_id echoed back unchanged");

await client.close();
if (failures > 0) {
  console.error(`\n💥 LOCAL MCP TEST FAILED — ${failures} assertion(s).\n`);
  process.exit(1);
}
console.log("\n🎯 PHASE 1 LOCAL TEST PASSED\n");
