import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./read.js";
import { registerPurchaseTools } from "./purchase.js";
import { registerUseTool } from "./use.js";

export function registerTools(server: McpServer, version: string, startedAt: number): void {
  registerReadTools(server, version, startedAt);
  registerPurchaseTools(server);
  registerUseTool(server);
}
