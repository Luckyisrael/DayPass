import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { proposeX402, x402OutputSchema } from "./paybox.js";

const PROTOCOL_VERSION = "2026-07-28";
const PLUGIN_NAME = "daypass";
const PLUGIN_VERSION = "0.1.0";
const USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FETCH_TIMEOUT_MS = 4_000;

/**
 * Daypass sells standing access: one payment opens a window in which an agent calls a
 * business's API as often as it likes, and the credit only stops when the window or the
 * allowance runs out.
 *
 * The hosted runtime gives every tool call a fresh sandbox with no memory, so this plugin
 * is deliberately stateless. It holds no passes and no counters — the merchant service is
 * the single system of record, and this bundle is only the storefront and the client.
 * That is what makes "pay once, use many" survive a process that dies between calls.
 */
function merchantOrigin(): URL {
  const raw = process.env.DAYPASS_MERCHANT_URL;
  if (!raw) {
    throw new Error(
      "DAYPASS_MERCHANT_URL is not configured. Set it to the merchant origin in PayBox Variables & Secrets.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DAYPASS_MERCHANT_URL must be an absolute https:// origin.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DAYPASS_MERCHANT_URL must be a bare https:// origin with no path, query or fragment.");
  }
  return url;
}

async function merchant(
  path: string,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const url = new URL(path, merchantOrigin());
  const response = await fetch(url, {
    method: init.method,
    headers: { accept: "application/json", ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Merchant returned a non-JSON body (HTTP ${response.status}).`);
    }
  }
  return { status: response.status, json };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// The catalogue is bundled rather than fetched so `daypass_list_offers` needs no network:
// it is the one tool that always answers, which keeps discovery and the hosted sample call
// deterministic. Prices are held in atomic USDC to avoid floating-point drift.
const OFFERS = [
  {
    id: "acme-weather-day",
    business: "Acme Weather API",
    name: "Day pass",
    description:
      "Unmetered current-conditions and forecast reads across every location in the Acme catalog.",
    priceUsd: "0.50",
    priceAtomic: "500000",
    durationMinutes: 1440,
    maxUses: 500,
    path: "/v1/weather",
  },
  {
    id: "acme-weather-week",
    business: "Acme Weather API",
    name: "Week pass",
    description: "Seven days of the same access, for agents that run on a schedule.",
    priceUsd: "2.00",
    priceAtomic: "2000000",
    durationMinutes: 10080,
    maxUses: 3000,
    path: "/v1/weather",
  },
  {
    id: "northwind-quote-hour",
    business: "Northwind Market Data",
    name: "Hour pass",
    description: "Sixty minutes of live FX and commodity quotes, refreshed on demand.",
    priceUsd: "0.25",
    priceAtomic: "250000",
    durationMinutes: 60,
    maxUses: 60,
    path: "/v1/quotes",
  },
] as const;

const offerId = z.string().min(1).max(128);
const passId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Expected a Daypass pass id (UUID).");

const offerSchema = z.object({
  id: z.string(),
  business: z.string(),
  name: z.string(),
  description: z.string(),
  priceUsd: z.string(),
  priceAtomic: z.string(),
  asset: z.string(),
  durationMinutes: z.number(),
  maxUses: z.number(),
  path: z.string(),
}).strict();

function createServer() {
  const server = new McpServer(
    { name: PLUGIN_NAME, version: PLUGIN_VERSION },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "daypass_list_offers",
    {
      title: "List Daypass offers",
      description:
        "Lists the access passes an agent can buy: each business, its price in USDC, how long the pass lasts and how many calls it covers.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ offers: z.array(offerSchema) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: `${OFFERS.length} passes for sale. Buy one with daypass_buy_pass, then call daypass_use.`,
        },
      ],
      structuredContent: {
        offers: OFFERS.map((o) => ({ ...o, asset: USDC_ASSET })),
      },
    }),
  );

  server.registerTool(
    "daypass_buy_pass",
    {
      title: "Buy a Daypass pass",
      description:
        "Proposes payment for one pass. PayBox settles it in USDC on Base and retries the merchant, which mints the pass and returns its id. Nothing is charged by this call alone.",
      inputSchema: z.object({ offerId }).strict(),
      outputSchema: x402OutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ offerId: requested }) => {
      const offer = OFFERS.find((o) => o.id === requested);
      if (!offer) {
        return failure(`No Daypass offer "${requested}". Call daypass_list_offers for the valid ids.`);
      }
      const url = new URL("/v1/passes", merchantOrigin());
      url.searchParams.set("offer", offer.id);
      return proposeX402({
        chain: "eip155:8453",
        url: url.toString(),
        method: "POST",
        body: { offerId: offer.id },
        maxAmount: offer.priceAtomic,
      });
    },
  );

  server.registerTool(
    "daypass_use",
    {
      title: "Use a Daypass pass",
      description:
        "Calls the pass's protected API. Each call spends one credit from the pass bought earlier; the response reports how many credits remain. Returns HTTP 402 once the pass is exhausted or its window has closed.",
      inputSchema: z.object({ passId }).strict(),
      outputSchema: z
        .object({
          ok: z.boolean(),
          status: z.number(),
          usesRemaining: z.number().nullable(),
          body: z.unknown(),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ passId: id }) => {
      // One endpoint, no client-side routing: the merchant owns the pass -> offer -> path
      // mapping, so the stateless plugin never has to remember which API it bought.
      const { status, json } = await merchant(`/v1/content/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: { "x-daypass-pass": id },
      });
      const record = (json ?? {}) as { usesRemaining?: number };
      return {
        content: [{ type: "text", text: `Merchant responded HTTP ${status}.` }],
        structuredContent: {
          ok: status >= 200 && status < 300,
          status,
          usesRemaining: typeof record.usesRemaining === "number" ? record.usesRemaining : null,
          body: json,
        },
      };
    },
  );

  server.registerTool(
    "daypass_status",
    {
      title: "Check a Daypass pass",
      description:
        "Reports a pass without spending a credit: how many calls are left, when the window closes, and whether it is still usable.",
      inputSchema: z.object({ passId }).strict(),
      outputSchema: z
        .object({
          ok: z.boolean(),
          status: z.number(),
          pass: z.unknown(),
        })
        .strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ passId: id }) => {
      const { status, json } = await merchant(`/v1/passes/${encodeURIComponent(id)}`, { method: "GET" });
      return {
        content: [{ type: "text", text: `Merchant responded HTTP ${status}.` }],
        structuredContent: { ok: status >= 200 && status < 300, status, pass: json },
      };
    },
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
