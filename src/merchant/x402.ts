import type { Context } from "hono";
import { buildAccepts, usdToAtomic, verifyPaymentProof } from "../plugin/payment.js";
import { issuePass } from "../plugin/passes.js";
import { findOffer, OFFERS, type Offer } from "../plugin/offers.js";

/**
 * The x402 surface. PayBox never lets a plugin move money, so the purchase has to be a real
 * HTTP payment flow the platform drives end to end:
 *
 *   1. an unpaid POST arrives -> we answer 402 with a live challenge naming asset and amount;
 *   2. PayBox verifies that challenge against the proposal, the user approves, PayBox pays;
 *   3. PayBox retries the same POST carrying the settlement in `X-PAYMENT`;
 *   4. we verify the signature ourselves, mint the pass, and hand back its id.
 *
 * Daypass stays the entitlement authority and never becomes the payer.
 */
const PAY_TO = process.env.DAYPASS_PAY_TO ?? "";
const X402_VERSION = 1;

export function payToAddress(): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
    throw new Error("DAYPASS_PAY_TO must be the merchant's 0x USDC receiving address.");
  }
  return PAY_TO;
}

/** True when the merchant cannot state where payment must land, so every mint would fail. */
export function misconfigured(): boolean {
  return !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO);
}

function offerFrom(ctx: Context, body: { offerId?: string } | null): Offer | undefined {
  const id = ctx.req.query("offer") ?? body?.offerId;
  return id ? findOffer(id) : undefined;
}

async function readBody(ctx: Context): Promise<{ offerId?: string } | null> {
  const text = await ctx.req.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as { offerId?: string };
  } catch {
    return null;
  }
}

/** POST /v1/passes — unpaid gets a challenge, paid gets a pass. */
export async function mintWithPayment(ctx: Context) {
  // Fail with a diagnosis, not a bare 500. A merchant that cannot say where payment must
  // land cannot quote a price either, and the operator needs to be told which env to set.
  if (misconfigured()) {
    return ctx.json(
      {
        error: "merchant_not_configured",
        message:
          "DAYPASS_PAY_TO is unset or not a 0x address, so this merchant cannot state where payment must land. Set it on the service and redeploy.",
      },
      503,
    );
  }

  const body = await readBody(ctx);
  const offer = offerFrom(ctx, body);

  if (!offer) {
    return ctx.json(
      {
        error: "unknown_offer",
        message: `No such offer. Available: ${OFFERS.map((o) => o.id).join(", ")}`,
      },
      400,
    );
  }

  const header = ctx.req.header("x-payment");
  if (!header) {
    // The 402 challenge. PayBox reads `accepts` and checks asset and amount against the
    // proposal it was handed, which is what stops a merchant quietly raising the price.
    return ctx.json(
      {
        x402Version: X402_VERSION,
        accepts: [
          buildAccepts({
            amountUsd: offer.priceUsd,
            description: `${offer.business} — ${offer.name}`,
            payTo: payToAddress(),
          }),
        ],
      },
      402,
    );
  }

  const verified = await verifyPaymentProof(header, {
    payTo: payToAddress(),
    amountAtomic: usdToAtomic(offer.priceUsd),
  });
  if (!verified.ok) {
    return ctx.json(
      {
        error: "payment_rejected",
        reason: verified.reason,
        message: "The payment proof did not verify. Do not retry blindly; check the payment status first.",
      },
      402,
    );
  }

  const pass = issuePass(offer.id);
  if (!pass) {
    return ctx.json({ error: "mint_failed", message: "The offer could not be issued." }, 500);
  }

  return ctx.json(
    {
      pass_id: pass.id,
      offer_id: pass.offerId,
      business: pass.business,
      uses_remaining: pass.usesRemaining,
      expires_at: new Date(pass.expiresAt).toISOString(),
      paid: { amount: verified.amount, payer: verified.payer },
    },
    201,
  );
}
