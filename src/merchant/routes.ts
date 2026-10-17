import { Hono } from "hono";
import { findOffer, offerPath, type Offer } from "../plugin/offers.js";
import { getPass, passStatus, spendUse, type Pass } from "../plugin/passes.js";
import { quotesSnapshot, weatherFor } from "./data.js";
import { paywall } from "./paywall.js";
import { mintWithPayment } from "./x402.js";

/**
 * The merchant's real API.
 *
 * Two kinds of route live here. The *meta* routes need no pass — the mint is gated by payment
 * and the status read is gated by the unguessable pass id itself. Everything under the content
 * routes is behind `paywall`, so the only way in is a pass somebody actually paid for.
 */
export const merchant = new Hono();

// --- meta -----------------------------------------------------------------

merchant.post("/v1/passes", mintWithPayment);

merchant.get("/v1/passes/:id", (ctx) => {
  const pass = getPass(ctx.req.param("id"));
  if (!pass) {
    return ctx.json({ error: "not_found", message: "No pass with that id has been issued." }, 404);
  }
  const offer = findOffer(pass.offerId);
  return ctx.json(passView(pass, offer, passStatus(pass)));
});

// Content behind a pass. The plugin presents the id in the header; the id is the credential,
// so there is no separate account, session or login to steal.
merchant.get("/v1/content/:passId", (ctx) => {
  const id = ctx.req.param("passId");
  const result = spendUse(id);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 401 : 402;
    return ctx.json({ error: result.reason, message: result.message, usesRemaining: null }, status);
  }

  const pass = result.pass;
  const offer = findOffer(pass.offerId);
  const body = serveOffer(offer, ctx.req.query("location"));
  return ctx.json({
    ...body,
    served_under: pass.id,
    usesRemaining: pass.usesRemaining,
    expiresAt: new Date(pass.expiresAt).toISOString(),
  });
});

// --- protected API --------------------------------------------------------

const GATED = ["/v1/whoami", "/v1/weather/*", "/v1/quotes"];
for (const path of GATED) merchant.use(path, paywall);

const passOf = (ctx: { get: (key: "pass") => Pass }): Pass => ctx.get("pass");

merchant.get("/v1/whoami", (ctx) => {
  const pass = passOf(ctx);
  return ctx.json({
    business: pass.business,
    access: "granted",
    pass_id: pass.id,
    uses_remaining: pass.usesRemaining,
    expires_at: new Date(pass.expiresAt).toISOString(),
  });
});

merchant.get("/v1/weather/:location", (ctx) => {
  const pass = passOf(ctx);
  return ctx.json({ ...weatherFor(ctx.req.param("location")), served_under: pass.id });
});

merchant.get("/v1/quotes", (ctx) => {
  const pass = passOf(ctx);
  return ctx.json({ ...quotesSnapshot(), served_under: pass.id });
});

// --- helpers --------------------------------------------------------------

function serveOffer(offer: Offer | undefined, location?: string) {
  const path = offer ? offerPath(offer) : "";
  if (path.startsWith("/v1/weather")) {
    return { business: offer!.business, ...weatherFor(location ?? "san-francisco") };
  }
  if (path.startsWith("/v1/quotes")) {
    return { business: offer!.business, ...quotesSnapshot() };
  }
  return { business: offer?.business ?? "unknown", note: "This pass covers an endpoint with no sample payload." };
}

function passView(pass: Pass, offer: Offer | undefined, status: ReturnType<typeof passStatus>) {
  return {
    pass_id: pass.id,
    offer_id: pass.offerId,
    business: pass.business,
    status,
    uses_remaining: pass.usesRemaining,
    max_uses: offer?.window.maxUses ?? null,
    expires_at: new Date(pass.expiresAt).toISOString(),
    created_at: new Date(pass.createdAt).toISOString(),
    ...(status === "active" ? {} : { reason: status === "expired" ? "expired" : "exhausted" }),
  };
}
