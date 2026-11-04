import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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

// Cap on a single /mcp request body. Without one the whole request is buffered
// and then copied again by Buffer.concat().toString(), so a large enough POST
// can take the process down before any tool-level limit applies. Sized above
// the biggest legitimate payload: tm1_upload_file accepts 32 MB of bytes, which
// is ~43 MB base64 plus JSON framing.
// ponytail: fixed constant, make it configurable if a deployment needs more.
const MAX_BODY_BYTES = 64 * 1024 * 1024;
export async function startHttpTransport(
  buildServer: () => { server: McpServer; dispose: () => void },
  config: TM1Config,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  // The SDK compares the Host header as one string, port included, so every
  // entry needs the port. Loopback names are safe to always allow: a rebinding
  // attacker's page sends its own hostname, never one of these.
  const allowedHosts = [
    ...new Set([
      `${config.httpHost}:${config.httpPort}`,
      `127.0.0.1:${config.httpPort}`,
      `localhost:${config.httpPort}`,
      `[::1]:${config.httpPort}`,
    ]),
  ];

  if (!config.httpToken) {
    logger.warn(
      "HTTP transport has no TM1_MCP_HTTP_TOKEN set — /mcp requests are unauthenticated. " +
        "Bind loopback only, or front the server with an authenticating reverse proxy.",
    );
  }

  const httpServer = createServer(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async request handler intentional; everything after the body read runs inside one try
    async (req: IncomingMessage, res: ServerResponse) => {
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
      // Stateless: no standing SSE stream (GET) and no session to end
      // (DELETE). The SDK would answer GET with an open stream that pins a
      // whole McpServer until the client hangs up, so refuse up front.
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "POST");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ error: "Method not allowed. Use POST /mcp." }),
        );
        return;
      }
      if (config.httpToken) {
        // Constant-time comparison: hashing both sides to fixed-length digests avoids
        // both the length-mismatch throw and the per-character timing oracle that `!==`
        // would leak, so the token can't be brute-forced via response-timing analysis.
        const expected = createHash("sha256")
          .update(`Bearer ${config.httpToken}`)
          .digest();
        const provided = createHash("sha256")
          .update(req.headers.authorization ?? "")
          .digest();
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
        // Refuse on the declared length before a single byte is read; the
        // counter below is the backstop for a chunked body that declares none.
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          logger.warn(
            { declared, limit: MAX_BODY_BYTES },
            "Request body too large",
          );
          res.statusCode = 413;
          res.setHeader("Content-Type", "application/json");
          // Close the connection: the client is still holding a body this
          // server will never read, and keep-alive would leave it queued.
          res.setHeader("Connection", "close");
          res.end(
            JSON.stringify({
              error: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
            }),
          );
          return;
        }
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const buf =
              typeof chunk === "string"
                ? Buffer.from(chunk)
                : (chunk as Buffer);
            size += buf.length;
            if (size > MAX_BODY_BYTES) {
              logger.warn({ limit: MAX_BODY_BYTES }, "Request body too large");
              res.statusCode = 413;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
                }),
              );
              // Answer first, then stop reading: the rest of the upload is
              // dropped instead of being buffered behind an already-sent reply.
              req.destroy();
              return;
            }
            chunks.push(buf);
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

      try {
        // Fresh server + transport per request (stateless single-use); tear
        // both down once the response is fully written so nothing leaks
        // between requests. Inside the try: a throw here would otherwise
        // escape the async handler and leave the request without an answer.
        const { server, dispose } = buildServer();
        const transport = new StreamableHTTPServerTransport({
          // sessionIdGenerator omitted → stateless mode (single-use per request)
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts,
          allowedOrigins: config.httpAllowedOrigins,
        });
        res.on("close", () => {
          // dispose() FIRST and synchronously: it detaches the per-build listener
          // from the process-global tm1Events emitter, which server.close() has no
          // knowledge of. Skipping it leaks one listener plus the server graph it
          // retains on every request — the transport builds a fresh server each
          // time, so the leak is unbounded, not one-off.
          dispose();
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        logger.error({ err }, "Transport handleRequest threw");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal transport error" }));
        }
      }
    },
  );

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
