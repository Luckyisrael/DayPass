import * as z from "zod/v4";

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
export const MUTATES_STATE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export const offerId = z.string().min(1).describe("The offer_id returned by daypass_discover.");
export const passId = z.string().min(1).describe("The pass_id returned when the pass was purchased.");

// Where pass payments land. The merchant sets this; it must be an address that can receive USDC on Base.
export const PAY_TO = process.env.MERCHANT_ADDRESS ?? "0x0000000000000000000000000000000000000001";
