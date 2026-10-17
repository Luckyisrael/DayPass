import { recoverTypedDataAddress, verifyTypedData } from "viem";

/**
 * The x402 payment contract Daypass presents, and the proof-checking that mints a pass.
 *
 * Daypass never moves money itself — the agent pays with PayBox's `pay_x402`. What we own is
 * the *entitlement*: accept a payment proof, prove it was really signed by the payer, and hand
 * back a pass. See KNOWLEDGE.md §15 for why the plugin cannot be the payer.
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const BASE_CHAIN_ID = 8453;
const USDC_DECIMALS = 6;

export const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: BASE_CHAIN_ID,
  verifyingContract: USDC_BASE,
} as const;

/**
 * One entry of the x402 `accepts` array. `resource` and `mimeType` are required by the x402
 * `PaymentRequirements` schema — a client parsing the challenge with that schema rejects a
 * response missing them, so they are emitted even though PayBox only documents verifying the
 * asset and the amount.
 */
export interface Accepts {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export function usdToAtomic(amountUsd: number): string {
  return BigInt(Math.round(amountUsd * 10 ** USDC_DECIMALS)).toString();
}

/** The 402 contract an agent hands to `pay_x402`. */
export function buildAccepts(params: {
  amountUsd: number;
  /** The exact URL being paid for; becomes the challenge's `resource`. */
  resource: string;
  description: string;
  payTo: string;
}): Accepts {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: usdToAtomic(params.amountUsd),
    resource: params.resource,
    description: params.description,
    mimeType: "application/json",
    // EIP-55 checksummed, matching PayBox's documented example. The plugin's proposal is
    // normalised to the same form, because PayBox compares the challenge against the proposal.
    asset: USDC_BASE,
    payTo: params.payTo,
    maxTimeoutSeconds: 600,
    extra: { name: "USD Coin", version: "2" },
  };
}

interface Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

interface PaymentProof {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: `0x${string}`; authorization: Authorization };
}

export type VerificationFailure =
  | "malformed_proof"
  | "wrong_network"
  | "wrong_recipient"
  | "insufficient_amount"
  | "expired"
  | "replayed"
  | "bad_signature";

export type VerificationResult =
  | { ok: true; payer: `0x${string}`; nonce: `0x${string}`; amount: string }
  | { ok: false; reason: VerificationFailure };

// Replay protection. Nonces are single-use in EIP-3009, so a proof must never mint twice.
const seenNonces = new Set<string>();

export async function verifyPaymentProof(
  base64Header: string,
  expected: { payTo: string; amountAtomic: string; nowMs?: number },
): Promise<VerificationResult> {
  let proof: PaymentProof;
  try {
    const decoded = Buffer.from(base64Header, "base64").toString("utf8");
    proof = JSON.parse(decoded) as PaymentProof;
  } catch {
    return { ok: false, reason: "malformed_proof" };
  }

  const auth = proof.payload?.authorization;
  const signature = proof.payload?.signature;
  if (!auth?.from || !auth.to || !auth.value || !auth.nonce || !signature) {
    return { ok: false, reason: "malformed_proof" };
  }
  if (proof.network !== "base") return { ok: false, reason: "wrong_network" };
  if (auth.to.toLowerCase() !== expected.payTo.toLowerCase()) {
    return { ok: false, reason: "wrong_recipient" };
  }
  if (BigInt(auth.value) < BigInt(expected.amountAtomic)) {
    return { ok: false, reason: "insufficient_amount" };
  }

  const now = BigInt(Math.floor((expected.nowMs ?? Date.now()) / 1000));
  if (now < BigInt(auth.validAfter) || now > BigInt(auth.validBefore)) {
    return { ok: false, reason: "expired" };
  }

  if (seenNonces.has(auth.nonce)) return { ok: false, reason: "replayed" };

  const message = {
    from: auth.from,
    to: auth.to,
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
  };

  // Verification can *throw* on a structurally invalid signature (e.g. secp256k1 point not on
  // curve) rather than returning false. A junk proof must produce a clean rejection, never a 500.
  let valid: boolean;
  let recovered: `0x${string}`;
  try {
    valid = await verifyTypedData({
      address: auth.from,
      domain: USDC_DOMAIN,
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });
    recovered = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });
  } catch {
    return { ok: false, reason: "bad_signature" };
  }

  // Two independent checks: verifyTypedData proves the signature is valid, and
  // recoverTypedDataAddress pins exactly which address produced it.
  if (!valid) return { ok: false, reason: "bad_signature" };
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return { ok: false, reason: "bad_signature" };
  }

  seenNonces.add(auth.nonce);
  return { ok: true, payer: auth.from, nonce: auth.nonce, amount: auth.value };
}
