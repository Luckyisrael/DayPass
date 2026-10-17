import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools/index.js";
import { merchant } from "../merchant/routes.js";

const PORT = Number(process.env.PORT ?? 8787);
const VERSION = "0.1.0";
const startedAt = Date.now();

function buildServer(): McpServer {
  const server = new McpServer({ name: "daypass", version: VERSION });
  registerTools(server, VERSION, startedAt);
  return server;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // PayBox sends no user identity on the auth:"none" path (KNOWLEDGE.md §12). This line is
  // the tripwire that would tell us if that ever changes once we adopt auth:"oauth".
  console.log(
    "[daypass:incoming]",
    JSON.stringify({ method: req.method, auth: req.headers["authorization"] ?? null }),
  );

  // A fresh server per connection: the SDK allows one transport per Protocol instance,
  // so a shared server throws "Already connected to a transport" under concurrency.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[daypass] MCP error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  } finally {
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

async function handleMerchant(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
  const method = req.method ?? "GET";
  // The x402 mint is a POST whose body carries the offer id, so the body has to be forwarded.
  // Dropping it would silently fall back to the query string and hide a real client bug.
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

  const request = new Request(`http://localhost:${PORT}${url}`, {
    method,
    headers: req.headers as HeadersInit,
    // Uint8Array rather than Buffer: Node's fetch accepts both, but only Uint8Array is
    // structurally a BodyInit, so the Buffer fails type-checking.
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
  });

  try {
    const response = await merchant.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("[daypass] merchant error:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
}

const httpServer = createServer((req, res) => {
  const url = req.url ?? "/";

  if (url.startsWith("/mcp")) return void handleMcp(req, res);
  if (url.startsWith("/v1")) return void handleMerchant(req, res, url);

  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ ok: true, plugin: "daypass", uptime_ms: Date.now() - startedAt }));
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", hint: "POST /mcp" }));
});

httpServer.listen(PORT, () => {
  console.log(`[daypass] listening on http://localhost:${PORT} (MCP: POST /mcp)`);
});
