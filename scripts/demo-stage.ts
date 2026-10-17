/**
 * Puts the store into a known, clean state right before a recording, so the demo starts
 * predictable instead of mid-run. Prints the pass_id to open with.
 * Run: npx tsx scripts/demo-stage.ts
 */
import { rmSync } from "node:fs";

const STORE = process.env.DAYPASS_STORE ?? ".daypass/passes.json";

rmSync(STORE, { force: true });

const { issuePass } = await import("../src/plugin/passes.js");
const { OFFERS } = await import("../src/plugin/offers.js");

const offer = OFFERS[2];
if (!offer) throw new Error("expected a third offer");

const pass = issuePass(offer.id);
if (!pass) throw new Error("could not stage a pass");

console.log("store cleared:", STORE);
console.log("staged pass :", pass.id);
console.log("business    :", pass.business);
console.log("window      :", offer.window.durationMinutes, "min /", offer.window.maxUses, "uses");
console.log("expires     :", new Date(pass.expiresAt).toISOString());
