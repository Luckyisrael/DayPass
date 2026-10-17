import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findOffer } from "./offers.js";

export interface Pass {
  id: string;
  offerId: string;
  business: string;
  usesRemaining: number;
  expiresAt: number;
  createdAt: number;
}

// A sold pass must outlive a restart, so state is written to disk on every change.
// Cheap and atomic enough at hackathon scale; a real deployment would use a database.
const STORE_PATH = resolve(process.env.DAYPASS_STORE ?? ".daypass/passes.json");

let passes = new Map<string, Pass>();

function load(): void {
  try {
    const rows = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Pass[];
    passes = new Map(rows.map((p) => [p.id, p]));
  } catch {
    passes = new Map();
  }
}

function persist(): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify([...passes.values()], null, 2));
}

load();

export function issuePass(offerId: string): Pass | undefined {
  const offer = findOffer(offerId);
  if (!offer) return undefined;

  const pass: Pass = {
    id: randomUUID(),
    offerId,
    business: offer.business,
    usesRemaining: offer.window.maxUses,
    expiresAt: Date.now() + offer.window.durationMinutes * 60_000,
    createdAt: Date.now(),
  };
  passes.set(pass.id, pass);
  persist();
  return pass;
}

export function getPass(passId: string): Pass | undefined {
  return passes.get(passId);
}

export type PassStatus = "active" | "expired" | "exhausted";

export function passStatus(pass: Pass, now = Date.now()): PassStatus {
  if (now >= pass.expiresAt) return "expired";
  if (pass.usesRemaining <= 0) return "exhausted";
  return "active";
}

export type SpendResult =
  | { ok: true; pass: Pass }
  | { ok: false; reason: "not_found" | "expired" | "exhausted"; message: string };

/** Consume one use. This is the gate: the pass either has credit or it doesn't. */
export function spendUse(passId: string, now = Date.now()): SpendResult {
  const pass = passes.get(passId);
  if (!pass) return { ok: false, reason: "not_found", message: "No pass with that id has been issued." };

  const status = passStatus(pass, now);
  if (status === "expired") {
    return {
      ok: false,
      reason: "expired",
      message: `This pass expired at ${new Date(pass.expiresAt).toISOString()}. Buy another to continue.`,
    };
  }
  if (status === "exhausted") {
    return {
      ok: false,
      reason: "exhausted",
      message: `Every included use has been spent. Buy another pass to continue.`,
    };
  }

  pass.usesRemaining -= 1;
  persist();
  return { ok: true, pass };
}
