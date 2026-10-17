import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { passStatus, spendUse } from "../passes.js";
import { toolResult } from "../envelope.js";
import { MUTATES_STATE, passId } from "./common.js";

export function registerUseTool(server: McpServer): void {
  server.registerTool(
    "daypass_use",
    {
      title: "Daypass: redeem one use of a pass",
      description:
        "Spend one use of a pass to access the business's API. This is the gate a merchant checks " +
        "before serving a request. Each successful call decrements the remaining uses by one; when " +
        "the window closes or the uses run out, the pass stops working and you must buy another.",
      inputSchema: { pass_id: passId },
      annotations: MUTATES_STATE,
    },
    async ({ pass_id }) => {
      const result = spendUse(pass_id);
      if (!result.ok) {
        return toolResult({
          status: result.reason === "not_found" ? "not_found" : "error",
          pass_id,
          reason: result.reason,
          message: result.message,
          next_step: "Call daypass_buy_pass to purchase a new pass, then daypass_redeem.",
        });
      }

      const pass = result.pass;
      return toolResult({
        status: "success",
        pass_id: pass.id,
        offer_id: pass.offerId,
        business: pass.business,
        uses_remaining: pass.usesRemaining,
        pass_state: passStatus(pass),
        expires_at: new Date(pass.expiresAt).toISOString(),
      });
    },
  );
}
