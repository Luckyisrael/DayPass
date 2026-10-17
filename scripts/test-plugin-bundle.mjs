#!/usr/bin/env node
// Exercises every Daypass tool against the built bundle, spawning a fresh process per
// operation. The fresh-process rule is the point: it mirrors the hosted sandbox, where no
// state survives between calls, so any tool that quietly depends on memory fails here.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const PROTOCOL_VERSION = "2026-07-28";
const ARTIFACT = resolve(import.meta.dirname, "../paybox-plugin/dist/plugin.mjs");
const MERCHANT = "https://merchant.daypass.example";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(env, method, params) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [ARTIFACT], {
      env: { HOME: "/tmp", NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const id = 7;
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error(`timeout after 10s (stderr: ${stderr.trim()})`));
    }, 10_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      lines.close();
      try {
        const message = JSON.parse(line);
        if (message.error) return rejectP(new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`));
        resolveP({ result: message.result, stderr });
      } catch (error) {
        rejectP(error);
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "daypass-local-tests", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );
  });
}

const toolCall = (env, name, args) => call(env, "tools/call", { name, arguments: args });

console.log("Daypass bundle — local tool tests\n");

// --- catalog -------------------------------------------------------------
const listed = await call({ DAYPASS_MERCHANT_URL: MERCHANT }, "tools/list", {});
const tools = listed.result.tools ?? [];
console.log("catalog");
check("4 tools discovered", tools.length === 4, `got ${tools.length}`);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
check(
  "expected tool names",
  ["daypass_list_offers", "daypass_buy_pass", "daypass_use", "daypass_status"].every((n) => byName[n]),
  Object.keys(byName).join(", "),
);
check(
  "list_offers is read-only / closed-world",
  byName.daypass_list_offers?.annotations?.readOnlyHint === true &&
    byName.daypass_list_offers?.annotations?.openWorldHint === false,
);
check(
  "use is NOT read-only (it spends a credit)",
  byName.daypass_use?.annotations?.readOnlyHint === false,
  JSON.stringify(byName.daypass_use?.annotations),
);
check(
  "status is read-only",
  byName.daypass_status?.annotations?.readOnlyHint === true,
);
check(
  "buy_pass declares the x402 output schema",
  JSON.stringify(byName.daypass_buy_pass?.outputSchema ?? {}).includes("io.paybox/transactionProposal"),
);

// --- offers --------------------------------------------------------------
console.log("\ndaypass_list_offers");
const offers = await toolCall({ DAYPASS_MERCHANT_URL: MERCHANT }, "daypass_list_offers", {});
check("succeeds", offers.result.isError !== true);
const rows = offers.result.structuredContent?.offers ?? [];
check("returns 3 offers", rows.length === 3, `got ${rows.length}`);
const northwind = rows.find((o) => o.id === "northwind-quote-hour");
check("northwind priced at 250000 atomic USDC", northwind?.priceAtomic === "250000", JSON.stringify(northwind?.priceAtomic));
check("northwind is 60 minutes / 60 uses", northwind?.durationMinutes === 60 && northwind?.maxUses === 60);
check("every offer names the Base USDC asset", rows.every((o) => o.asset.toLowerCase() === USDC.toLowerCase()));

// --- buy -----------------------------------------------------------------
console.log("\ndaypass_buy_pass");
const env = { DAYPASS_MERCHANT_URL: MERCHANT };
const buy = await toolCall(env, "daypass_buy_pass", { offerId: "northwind-quote-hour" });
const proposal = buy.result.structuredContent?.["io.paybox/transactionProposal"];
check("returns a proposal", buy.result.isError !== true && !!proposal);
check("kind is x402", proposal?.kind === "x402");
check("chain is Base", proposal?.chain === "eip155:8453");
check("points at the merchant mint endpoint", proposal?.request?.url === `${MERCHANT}/v1/passes?offer=northwind-quote-hour`, proposal?.request?.url);
check("posts the offer id", proposal?.request?.method === "POST" && proposal?.request?.body?.offerId === "northwind-quote-hour");
check("maxAmount is the offer price", proposal?.payment?.maxAmount === "250000", proposal?.payment?.maxAmount);
check("asset is Base USDC", (proposal?.payment?.asset ?? "").toLowerCase() === USDC);
check("version is 1", proposal?.version === "1");
const expiry = Date.parse(proposal?.expiresAt ?? "");
check(
  "expiry is a whole-second UTC stamp within five minutes",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(proposal?.expiresAt ?? "") &&
    expiry > Date.now() &&
    expiry <= Date.now() + 300_000,
  proposal?.expiresAt,
);
check("proposal text warns nothing has been paid", /nothing has been signed or paid/i.test(buy.result.content?.[0]?.text ?? ""));

const bogus = await toolCall(env, "daypass_buy_pass", { offerId: "does-not-exist" });
check("unknown offer is a clean tool error", bogus.result.isError === true);
check("unknown offer names the recovery step", /daypass_list_offers/.test(bogus.result.content?.[0]?.text ?? ""));

// --- statelessness of configuration --------------------------------------
console.log("\nmissing configuration");
const unconfigured = await toolCall({}, "daypass_buy_pass", { offerId: "northwind-quote-hour" });
check("buy_pass without DAYPASS_MERCHANT_URL errors cleanly", unconfigured.result.isError === true);
check(
  "the error says what to configure",
  /DAYPASS_MERCHANT_URL/.test(unconfigured.result.content?.[0]?.text ?? ""),
);
const unconfiguredOffers = await toolCall({}, "daypass_list_offers", {});
check("list_offers still works with no merchant configured", unconfiguredOffers.result.isError !== true);

// --- merchant-dependent tools degrade cleanly, never crash ---------------
console.log("\nmerchant-dependent tools (no merchant reachable)");
for (const name of ["daypass_use", "daypass_status"]) {
  const result = await toolCall(env, name, { passId: "00000000-0000-4000-8000-000000000000" });
  check(`${name} returns a result rather than crashing`, result.result !== undefined);
  check(`${name} surfaces the failure as isError`, result.result.isError === true);
}
const malformed = await toolCall(env, "daypass_use", { passId: "not-a-uuid" });
check("malformed pass id is rejected by the schema", malformed.result.isError === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
