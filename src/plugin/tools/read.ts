import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OFFERS } from "../offers.js";
import { getPass, passStatus } from "../passes.js";
import { toolResult } from "../envelope.js";
import { READ_ONLY, passId } from "./common.js";

export function registerReadTools(server: McpServer, version: string, startedAt: number): void {
  server.registerTool(
    "daypass_ping",
    {
      title: "Daypass: ping",
      description:
        "Health check for the Daypass plugin. Call this first to confirm Daypass is reachable " +
        "before attempting a purchase.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => toolResult({ pong: true, plugin: "daypass", version, uptime_ms: Date.now() - startedAt }),
  );

  server.registerTool(
    "daypass_discover",
    {
      title: "Daypass: discover businesses",
      description:
        "List the businesses an agent can buy access from. Each result is an offer: an id, the " +
        "business, a price in USD, an access window (duration and allowed uses), and the base URL " +
        "the pass unlocks. This call spends nothing and moves no money.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      toolResult({
        status: "success",
        offers: OFFERS.map((o) => ({
          offer_id: o.id,
          business: o.business,
          name: o.name,
          description: o.description,
          price_usd: o.priceUsd,
          window: { duration_minutes: o.window.durationMinutes, max_uses: o.window.maxUses },
          url: o.url,
        })),
        hint: "To buy, call daypass_buy_pass with an offer_id. The person approves with a passkey.",
      }),
  );

  server.registerTool(
    "daypass_status",
    {
      title: "Daypass: check a pass",
      description:
        "Report the remaining time and remaining uses on one pass. Call this before using a pass " +
        "so you don't waste a use on one that is expired or exhausted.",
      inputSchema: { pass_id: passId },
      annotations: READ_ONLY,
    },
    async ({ pass_id }) => {
      const pass = getPass(pass_id);
      if (!pass)
        return toolResult({
          status: "not_found",
          pass_id,
          message: "No pass with that id has been issued. Passes are created by daypass_redeem.",
        });

      return toolResult({
        status: passStatus(pass),
        pass_id,
        offer_id: pass.offerId,
        business: pass.business,
        uses_remaining: pass.usesRemaining,
        expires_at: new Date(pass.expiresAt).toISOString(),
      });
    },
  );
}
