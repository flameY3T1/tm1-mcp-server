#!/usr/bin/env node
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type pino from "pino";
import { loadConfig, type TM1Config } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { TM1Client } from "./tm1-client.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllResources } from "./resources/index.js";
import { SubscriptionRegistry } from "./resources/subscriptions.js";
import { installPaginatedListHandler } from "./resources/list-handler.js";
import { registerAllTools } from "./tools/index.js";
import { withAnnotations } from "./tools/with-annotations.js";
import { NAME, VERSION } from "./version.js";

// stdio transport: existing Claude-Code/Desktop entry path.
async function startStdioTransport(
  server: McpServer,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server listening on stdio");
  return async () => {
    await transport.close();
  };
}

// Streamable HTTP transport (stateless JSON, single /mcp endpoint). Per MCP
// best practices: bind 127.0.0.1 by default and enable DNS rebinding
// protection. allowedHosts/Origins narrow what the underlying transport will
// accept on incoming requests.
async function startHttpTransport(
  server: McpServer,
  config: TM1Config,
  logger: pino.Logger,
): Promise<() => Promise<void>> {
  const allowedHost = `${config.httpHost}:${config.httpPort}`;
  const transport = new StreamableHTTPServerTransport({
    // sessionIdGenerator omitted → stateless mode
    enableDnsRebindingProtection: true,
    allowedHosts: [allowedHost, "127.0.0.1", "localhost"],
    allowedOrigins: config.httpAllowedOrigins,
  });
  // Cast needed: StreamableHTTPServerTransport.onclose is `(() => void) | undefined`
  // but Transport expects `() => void`; EOPT surfaces this library-internal mismatch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await server.connect(transport as any);

  if (!config.httpToken) {
    logger.warn(
      "HTTP transport has no TM1_MCP_HTTP_TOKEN set — /mcp requests are unauthenticated. " +
        "Bind to loopback only, or front the server with an authenticating reverse proxy.",
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async request handler is intentional; errors are caught internally
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith("/mcp")) {
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
    try {
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
    "MCP server listening on HTTP (Streamable, stateless)",
  );

  return async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await transport.close();
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("Starting TM1 MCP Server");

  const sessionManager = new SessionManager(config, logger);
  const tm1Client = new TM1Client(config, sessionManager, logger);

  // Try to connect to TM1, but don't block MCP server startup.
  // request() calls ensureSession() on every tool invocation, so a tool call
  // will retry auth if the initial connect failed. Keeps Claude able to list
  // tools and report a meaningful error instead of crashing the whole process.
  try {
    await tm1Client.connect();
    logger.info("TM1 client connected");
  } catch (err) {
    logger.warn(
      { err },
      "Initial TM1 connection failed — server will retry on first tool call",
    );
  }

  // Create MCP server.
  // Capabilities explicitly declared per MCP spec recommendation:
  //   tools / resources / prompts — auto-registered by the SDK when the
  //     respective register* helper is first called, declared here for
  //     self-documentation and to allow listChanged toggling later.
  //   logging — NOT auto-registered by the SDK; declaring it unlocks
  //     server.sendLoggingMessage() so we can surface slow-query and
  //     deprecation events in the client-side log panel.
  const server = new McpServer(
    {
      name: NAME,
      version: VERSION,
    },
    {
      capabilities: {
        // R2-06: declare listChanged so clients listen for
        // notifications/tools/list_changed. SDK fires automatically when
        // McpServer.tool() is called post-connect (currently never; lays
        // groundwork for future version-conditional tool gating).
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        logging: {},
      },
    },
  );

  // Register all tools — wrap server so each registration receives the
  // annotation hint from ANNOTATION_MAP without editing call sites.
  // In readonly mode the proxy silently drops write/destructive tools so they
  // never appear in the tool listing — no autoApprove lists needed.
  if (config.mode === "readonly") {
    logger.info("TM1_MODE=readonly — write and destructive tools will not be registered");
  }
  registerAllTools(withAnnotations(server, logger, config.mode), tm1Client);
  logger.info(`All MCP tools registered (mode: ${config.mode})`);

  // Register MCP Resources (URI-addressable read-only views over TM1
  // objects). Mirrors a subset of the get_* tool surface so IDE clients
  // can `#`-reference TM1 objects in chat or browse a sidebar tree.
  const resourceCatalog = registerAllResources(server, tm1Client);
  logger.info("All MCP resources registered");

  // R2-07: replace SDK's default ListResourcesRequestSchema handler with a
  // cursor-aware override that paginates the combined static + template
  // resource list. SDK 1.29.0 does not forward params.cursor or honor
  // nextCursor on its high-level handler; this override is the only way to
  // serve TM1 sites with thousands of processes/cubes spec-compliantly.
  installPaginatedListHandler(server, resourceCatalog, logger);

  // R2-05: install subscribe/unsubscribe handlers and bridge HTTP-layer
  // mutation events to notifications/resources/updated for any client that
  // subscribed to tm1://server/state. Decoupled from the HTTP layer via
  // the tm1Events bus so transport-side concerns don't reach into MCP.
  const subscriptions = new SubscriptionRegistry(server, logger);
  subscriptions.install();
  logger.info("Resource subscription registry installed");

  // Register MCP Prompts (parameterised templates surfaced as slash-
  // commands in IDE clients). Each prompt briefs the LLM with a concrete
  // tool sequence for a common TM1 workflow.
  registerAllPrompts(server);
  logger.info("All MCP prompts registered");

  // Branch on transport. stdio is the default for local MCP-client setups
  // (Claude Code, Claude Desktop). http (Streamable HTTP, stateless) is for
  // remote/multi-client deploys; binds to 127.0.0.1 by default with DNS-
  // rebinding protection per MCP spec recommendation.
  const httpCloser = config.transport === "http"
    ? await startHttpTransport(server, config, logger)
    : await startStdioTransport(server, logger);

  // Graceful shutdown — ensure TM1 session is always cleaned up.
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down TM1 MCP Server");
    try {
      await httpCloser?.();
    } catch (err) {
      logger.error({ err }, "Error closing transport");
    }
    try {
      await tm1Client.disconnect();
    } catch (err) {
      logger.error({ err }, "Error during disconnect");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { void shutdown("SIGHUP"); });

  // Parent process death — only meaningful on stdio (Claude spawns us as a
  // child). For http we ignore stdin events since the process lifecycle is
  // independent.
  if (config.transport === "stdio") {
    process.stdin.on("end", () => {
      logger.info("stdin ended (parent process gone), shutting down");
      void shutdown("stdin-end");
    });
    process.stdin.on("close", () => {
      logger.info("stdin closed, shutting down");
      void shutdown("stdin-close");
    });
  }

  // Last resort — try to clean up the TM1 session on uncaught errors.
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception, attempting cleanup");
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });
}

main().catch((err) => {
   
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
