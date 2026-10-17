import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { findOffer } from "../offers.js";
import { issuePass } from "../passes.js";
import { buildAccepts, usdToAtomic, verifyPaymentProof } from "../payment.js";
import { toolResult } from "../envelope.js";
import { MUTATES_STATE, PAY_TO, offerId } from "./common.js";

const xPayment = z
  .string()
  .min(1)
  .describe("The X-PAYMENT header returned by pay_x402, as base64. Pass it through unchanged.");

const NOT_FOUND = (id: string) =>
  toolResult({ status: "error", message: `Unknown offer_id: ${id}` });

export function registerPurchaseTools(server: McpServer): void {
  server.registerTool(
    "daypass_buy_pass",
    {
      title: "Daypass: get payment terms for a pass",
      description:
        "Get the exact payment terms for standing access to a business's API. This does NOT move " +
        "money — it returns an x402 'accepts' contract. Pay it with pay_x402, which is what makes " +
        "the person approve with their passkey. Then pass the returned payment proof to " +
        "daypass_redeem to receive your pass_id.",
      inputSchema: { offer_id: offerId },
      annotations: MUTATES_STATE,
    },
    async ({ offer_id }) => {
      const offer = findOffer(offer_id);
      if (!offer) return NOT_FOUND(offer_id);

      const accepts = buildAccepts({
        amountUsd: offer.priceUsd,
        resource: offer.url,
        description: `${offer.business} — ${offer.name}`,
        payTo: PAY_TO,
      });

      return toolResult({
        status: "payment_required",
        offer_id: offer.id,
        business: offer.business,
        price_usd: offer.priceUsd,
        accepts: [accepts],
        resource_url: offer.url,
        next_step:
          "Pay exactly this contract with pay_x402 (accepts, credential_id, resource_url), then " +
          "call daypass_redeem with this offer_id and the returned x_payment value. Do not call " +
          "daypass_buy_pass again — it would produce new terms and a second charge.",
      });
    },
  );

  server.registerTool(
    "daypass_redeem",
    {
      title: "Daypass: redeem a payment for a pass",
      description:
        "Turn a completed x402 payment into a pass. Call this once, after pay_x402 succeeds, " +
        "passing the exact x_payment value it returned. On success you get a pass_id — every " +
        "later call to the protected API presents that pass instead of paying again.",
      inputSchema: { offer_id: offerId, x_payment: xPayment },
      annotations: MUTATES_STATE,
    },
    async ({ offer_id, x_payment }) => {
      const offer = findOffer(offer_id);
      if (!offer) return NOT_FOUND(offer_id);

      const verified = await verifyPaymentProof(x_payment, {
        payTo: PAY_TO,
        amountAtomic: usdToAtomic(offer.priceUsd),
      });
      if (!verified.ok) {
        return toolResult({
          status: "error",
          message: `Payment proof rejected: ${verified.reason}. No pass was issued.`,
          reason: verified.reason,
        });
      }

      const pass = issuePass(offer_id);
      if (!pass) return NOT_FOUND(offer_id);

      return toolResult({
        status: "success",
        pass_id: pass.id,
        offer_id: pass.offerId,
        business: pass.business,
        paid_atomic: verified.amount,
        payer: verified.payer,
        uses_remaining: pass.usesRemaining,
        expires_at: new Date(pass.expiresAt).toISOString(),
        next_step: "Hold this pass_id. Present it to daypass_use for every call inside the window.",
      });
    },
  );
}
