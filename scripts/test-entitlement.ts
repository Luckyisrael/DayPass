/**
 * Gate 3: the entitlement core must actually gate. Proves uses decrement, exhaustion,
 * expiry, unknown passes, and — via a real subprocess — that a sold pass survives a restart.
 * Run: npx tsx scripts/test-entitlement.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storeDir = mkdtempSync(join(tmpdir(), "daypass-store-"));
const store = join(storeDir, "passes.json");
process.env.DAYPASS_STORE = store;

const { issuePass, spendUse, passStatus, getPass } = await import("../src/plugin/passes.js");
const { OFFERS } = await import("../src/plugin/offers.js");

let failures = 0;
const check = (cond: boolean, label: string, detail = "") =>
  cond ? console.log(`✅ ${label}`) : (failures++, console.error(`❌ ${label} ${detail}`));

const [offer, , shortOffer] = OFFERS;
if (!offer || !shortOffer) throw new Error("expected at least 3 offers");
const maxUses = offer.window.maxUses;
const DAY = offer.window.durationMinutes * 60_000;

// --- a fresh pass is active and fully credited
const pass = issuePass(offer.id)!;
check(pass.usesRemaining === maxUses, `new pass starts with ${maxUses} uses`);
check(passStatus(pass) === "active", "new pass is active");

// --- each use decrements exactly one
const first = spendUse(pass.id);
check(first.ok && first.pass.usesRemaining === maxUses - 1, "each use decrements by exactly one");

// --- exhausting the pass blocks further use, cleanly
for (let i = 0; i < maxUses - 1; i++) spendUse(pass.id);
check(getPass(pass.id)!.usesRemaining === 0, "all uses consumed");
const over = spendUse(pass.id);
check(!over.ok && over.reason === "exhausted", "use on exhausted pass is refused", JSON.stringify(over));
check(getPass(pass.id)!.usesRemaining === 0, "refused use did not over-decrement");
check(passStatus(getPass(pass.id)!) === "exhausted", "exhausted pass reports exhausted");

// --- an unknown pass is refused, not an exception
const missing = spendUse("00000000-0000-4000-8000-000000000000");
check(!missing.ok && missing.reason === "not_found", "unknown pass refused", JSON.stringify(missing));

// --- an expired pass is refused even with uses left
const shortLived = issuePass(shortOffer.id)!;
const expired = spendUse(shortLived.id, shortLived.expiresAt + 60_000);
check(!expired.ok && expired.reason === "expired", "expired pass refused", JSON.stringify(expired));
check(shortLived.usesRemaining === shortOffer.window.maxUses, "expired pass kept its unused credit");

// --- persistence: a brand-new process must still see the sold pass
const probe = `
  (async () => {
    const { getPass } = await import("./src/plugin/passes.js");
    const p = getPass(${JSON.stringify(pass.id)});
    console.log(p ? "FOUND:" + p.usesRemaining : "MISSING");
  })();
`;
const out = execFileSync("npx", ["tsx", "-e", probe], {
  cwd: process.cwd(),
  env: { ...process.env, DAYPASS_STORE: store },
  encoding: "utf8",
}).trim();
check(out === "FOUND:0", "pass survives a restart (fresh process reads the store)", out);

rmSync(storeDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n💥 ENTITLEMENT TEST FAILED — ${failures} assertion(s).\n`);
  process.exit(1);
}
console.log("\n🎯 ENTITLEMENT TEST PASSED\n");
