/**
 * PayBox smoke test — verifies auth + credentials + plugin catalog.
 *
 * Run:  node scripts/smoke.mjs
 *
 * Exits non-zero if any check fails, so it can gate a build.
 */
import { execSync } from "node:child_process";

const run = (args) => {
  try {
    return JSON.parse(execSync(`npx --no-install paybox --json ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch (err) {
    return { __error: String(err.message || err).split("\n")[0] };
  }
};

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

// 1. Auth
const who = run("whoami");
add("auth configured", who.auth && who.auth !== "none", `auth=${who.auth ?? "?"}`);
add("can sign", who.canSign === true, `canSign=${who.canSign}`);

// 2. Credentials
const creds = run("credentials");
if (creds.__error) {
  add("credentials reachable", false, creds.__error);
} else {
  const list = creds.credentials ?? [];
  add("credentials reachable", true, `${list.length} granted`);
  for (const c of list) {
    const cred = c.credential ?? c;
    const kind = cred.credential_type ?? cred.kind ?? "?";
    add(`  credential: ${cred.name ?? "?"} (${kind})`,
      true, `id=${(cred.id ?? "").slice(0, 8)}… grant=${c.grant?.approval_mode ?? "?"}`);
  }
}

// 3. Plugin catalog
const plugins = run("plugins list");
if (plugins.__error) {
  add("plugin catalog", false, plugins.__error);
} else {
  const n = (plugins.plugins ?? []).length;
  add("plugin catalog", true, `${n} plugin(s)`);
}

// Report
console.log("\nPayBox smoke test\n" + "─".repeat(52));
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(`${c.ok ? "✅" : "❌"} ${c.name.padEnd(28)} ${c.detail ?? ""}`);
}
console.log("─".repeat(52));
console.log(failed === 0 ? "All checks passed. Ready to build." : `${failed} check(s) failing.`);
process.exit(failed === 0 ? 0 : 1);
