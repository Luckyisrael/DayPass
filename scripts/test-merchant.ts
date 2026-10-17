/**
 * Gate 4: the merchant must serve content ONLY to a pass the plugin issued.
 * Exercises the paywall directly — no port, no tunnel, no money.
 * Run: npx tsx scripts/test-merchant.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "daypass-merchant-"));
process.env.DAYPASS_STORE = join(storeDir, "passes.json");

const { issuePass, getPass } = await import("../src/plugin/passes.js");
const { OFFERS } = await import("../src/plugin/offers.js");
const { merchant } = await import("../src/merchant/routes.js");

let failures = 0;
const check = (cond: boolean, label: string, detail = "") =>
  cond ? console.log(`✅ ${label}`) : (failures++, console.error(`❌ ${label} ${detail}`));

const get = (path: string, passId?: string) =>
  merchant.fetch(
    new Request(`http://localhost${path}`, {
      headers: passId ? { "X-Daypass-Pass": passId } : {},
    }),
  );

const offer = OFFERS[2];
if (!offer) throw new Error("expected a third offer");

// 1. No pass at all — must be refused, and must leak no content.
const anon = await get("/v1/quotes");
const anonBody = (await anon.json()) as Record<string, unknown>;
check(anon.status === 401, "unpaid request refused with 401", `got ${anon.status}`);
check(!("fx" in anonBody), "unpaid response leaks no quotes", JSON.stringify(anonBody));
check(anonBody.error === "pass_required", "unpaid response names the problem");

// 2. A pass that was never issued.
const bogus = await get("/v1/quotes", "00000000-0000-4000-8000-000000000000");
check(bogus.status === 401, "unknown pass refused with 401", `got ${bogus.status}`);

// 3. A real pass gets real content, and paying costs exactly one use.
const pass = issuePass(offer.id)!;
const before = getPass(pass.id)!.usesRemaining;
const ok = await get("/v1/quotes", pass.id);
const okBody = (await ok.json()) as { fx?: unknown[]; served_under?: string; observed_at?: string };
check(ok.status === 200, "valid pass served content", `got ${ok.status}`);
check(Array.isArray(okBody.fx) && okBody.fx.length === 6, "response carries the full quote set");
check(okBody.served_under === pass.id, "response is stamped with the granting pass");
check(getPass(pass.id)!.usesRemaining === before - 1, "exactly one use was spent");

// 4. A second, different merchant route honours the same pass.
const weather = await get("/v1/weather/London", pass.id);
const wBody = (await weather.json()) as { location?: string; condition?: string };
check(weather.status === 200, "same pass opens a second route");
check(wBody.location === "London", "route parameter reaches the data layer", JSON.stringify(wBody));

// 5. Exhaustion stops the API, cleanly and with a reason.
const tiny = issuePass(offer.id)!;
for (let i = 0; i < offer.window.maxUses; i++) await get("/v1/quotes", tiny.id);
const spent = await get("/v1/quotes", tiny.id);
check(spent.status === 402, "exhausted pass refused with 402", `got ${spent.status}`);
const spentBody = (await spent.json()) as { error?: string };
check(spentBody.error === "exhausted", "exhausted refusal names the reason", JSON.stringify(spentBody));

rmSync(storeDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n💥 MERCHANT TEST FAILED — ${failures} assertion(s).\n`);
  process.exit(1);
}
console.log("\n🎯 MERCHANT PAYWALL TEST PASSED\n");
