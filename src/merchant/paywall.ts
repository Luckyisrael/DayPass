import type { Context, Next } from "hono";
import { spendUse } from "../plugin/passes.js";

/**
 * The gate itself. The merchant's API serves content only to a pass the plugin issued,
 * so the MCP tools and this middleware share one store — that coupling is the product.
 *
 * A pass is presented via the `X-Daypass-Pass` header or a `pass_id` query param.
 */
export async function paywall(ctx: Context, next: Next) {
  const presented = ctx.req.header("X-Daypass-Pass") ?? ctx.req.query("pass_id");

  if (!presented) {
    return ctx.json(
      {
        error: "pass_required",
        message: "Present a Daypass pass in the X-Daypass-Pass header.",
        how: "Buy a pass with the Daypass plugin (daypass_buy_pass), then call daypass_use with the pass id it returns.",
      },
      401,
    );
  }

  const result = spendUse(presented);
  if (!result.ok) {
    const status = result.reason === "not_found" ? 401 : 402;
    return ctx.json({ error: result.reason, message: result.message }, status);
  }

  // Credit is spent now, before the work runs, so a slow handler can't grant free access.
  ctx.set("pass", result.pass);
  await next();
}
