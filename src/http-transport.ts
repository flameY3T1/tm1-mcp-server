import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type pino from "pino";
import type { TM1Config } from "./config.js";

// Streamable HTTP transport (stateless JSON, single /mcp endpoint).
//
// Stateless mode (sessionIdGenerator omitted) means each StreamableHTTPServerTransport
// is single-use: the SDK throws "Stateless transport cannot be reused across requests"
// on the second handleRequest. So we build a *fresh* McpServer + transport per request
// and tear both down when the response closes — the SDK-documented stateless pattern.
// This is cheap: registration is pure in-memory wiring with no I/O, and the shared
// TM1 client (captured by the buildServer closure) is not rebuilt.
//
// Consequence: there is no standing server->client stream, so subscribe/logging
// notifications are not delivered over HTTP. That is acceptable for the intended
// deployment (one process per TM1 identity; stdio remains the push-capable default).
//
// Per MCP best practices: bind 127.0.0.1 by default and enable DNS-rebinding
// protection. allowedHosts/Origins narrow what the transport accepts.
export async function startHttpTransport(
  buildServer: () => McpServer,
  config: TM1Config,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  const allowedHost = `${config.httpHost}:${config.httpPort}`;

  if (!config.httpToken) {
    logger.warn(
      "HTTP transport has no TM1_MCP_HTTP_TOKEN set — /mcp requests are unauthenticated. " +
        "Bind loopback only, or front the server with an authenticating reverse proxy.",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async request handler intentional; errors are caught internally
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Match the exact /mcp endpoint (optionally with a query string) or a real
    // subpath under /mcp/. A loose startsWith("/mcp") would also accept
    // /mcpFoo, routing an unrelated path into the MCP transport.
    const path = (req.url ?? "").split(/[?#]/, 1)[0] ?? "";
    if (path !== "/mcp" && !path.startsWith("/mcp/")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
      return;
    }
    if (config.httpToken) {
      // Constant-time comparison: hashing both sides to fixed-length digests avoids
      // both the length-mismatch throw and the per-character timing oracle that `!==`
      // would leak, so the token can't be brute-forced via response-timing analysis.
      const expected = createHash("sha256").update(`Bearer ${config.httpToken}`).digest();
      const provided = createHash("sha256").update(req.headers.authorization ?? "").digest();
      if (!timingSafeEqual(expected, provided)) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("WWW-Authenticate", "Bearer");
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }
    let body: unknown;
    if (req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        body = raw ? JSON.parse(raw) : undefined;
      } catch (err) {
        logger.warn({ err }, "Bad JSON in /mcp body");
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
    }

    // Fresh server + transport per request (stateless single-use); tear both down
    // once the response is fully written so nothing leaks between requests.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      // sessionIdGenerator omitted → stateless mode (single-use per request)
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [allowedHost, "127.0.0.1", "localhost"],
      allowedOrigins: config.httpAllowedOrigins,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      // Cast: StreamableHTTPServerTransport.onclose is `(() => void) | undefined`
      // while Transport expects `() => void`; the cast papers over that library-
      // internal signature mismatch without changing behaviour.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await server.connect(transport as any);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error({ err }, "Transport handleRequest threw");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal transport error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpHost, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  logger.info(
    {
      host: config.httpHost,
      port: config.httpPort,
      endpoint: "/mcp",
      allowedOrigins: config.httpAllowedOrigins,
      dnsRebindingProtection: true,
    },
    "MCP server listening on HTTP (Streamable, stateless, per-request)",
  );

  return async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}
