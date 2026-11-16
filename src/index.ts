#!/usr/bin/env node
import "./load-env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
import { startHttpTransport } from "./http-transport.js";
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

// Build a fully-registered MCP server (tools + resources + prompts). Called once
// for stdio, and once per request for the stateless HTTP transport — so the
// per-build logging is at debug to avoid per-request spam. Registration is pure
// in-memory wiring (no I/O); the TM1 client is shared, not rebuilt.
//
// Capabilities are declared explicitly per MCP spec recommendation:
//   tools / resources / prompts — auto-registered by the SDK when the respective
//     register* helper is first called; declared here for self-documentation and
//     to allow listChanged toggling later.
//   logging — NOT auto-registered by the SDK; declaring it unlocks
//     server.sendLoggingMessage() (delivered on stdio; HTTP stateless has no
//     standing stream, so notifications are not pushed there).
export interface BuiltMcpServer {
  server: McpServer;
  /**
   * Detach everything this build attached to PROCESS-GLOBAL state — today the
   * SubscriptionRegistry's `tm1Events` listener. `server.close()` does NOT do
   * this: the registry holds its listener on an emitter the server knows
   * nothing about, so closing the server leaves it subscribed forever.
   *
   * Only the stdio build has a registry; for the stateless HTTP build this is
   * a no-op. Must still be invoked by every transport teardown path.
   */
  dispose: () => void;
  /**
   * Re-check the tools whose `enabled` gate depends on TM1 (ToolSpec.enabled).
   * Only stdio needs it: an HTTP build is made per request and reads the
   * current value while registering.
   */
  recheckTools: () => void;
}

function buildMcpServer(
  tm1Client: TM1Client,
  config: TM1Config,
  logger: pino.Logger,
): BuiltMcpServer {
  // Stateless HTTP drops the server when the response closes, so a subscription
  // could never be notified. Only stdio advertises and accepts subscriptions.
  const pushCapable = config.transport === "stdio";
  const server = new McpServer(
    {
      name: NAME,
      version: VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: pushCapable },
        prompts: { listChanged: true },
        logging: {},
      },
    },
  );

  // Register all tools — wrap the server so each registration receives the
  // annotation hint from ANNOTATION_MAP without editing call sites. In readonly
  // mode the proxy silently drops write/destructive tools so they never appear
  // in the tool listing — no autoApprove lists needed.
  const recheckTools = registerAllTools(
    withAnnotations(server, logger, config.mode, config.responseMode),
    tm1Client,
  );
  logger.debug(`All MCP tools registered (mode: ${config.mode})`);

  // Register MCP Resources (URI-addressable read-only views over TM1 objects).
  const resourceCatalog = registerAllResources(server, tm1Client);

  // R2-07: replace the SDK's default ListResourcesRequestSchema handler with a
  // cursor-aware override that paginates the combined static + template list.
  installPaginatedListHandler(server, resourceCatalog, logger);

  // R2-05: install subscribe/unsubscribe handlers and bridge HTTP-layer mutation
  // events to notifications/resources/updated for subscribers of tm1://server/state.
  const subscriptions = pushCapable
    ? new SubscriptionRegistry(server, logger)
    : undefined;
  subscriptions?.install();

  // Register MCP Prompts (parameterised workflow templates surfaced as slash-commands).
  registerAllPrompts(server);
  logger.debug("All MCP resources and prompts registered");

  return {
    server,
    recheckTools,
    dispose: () => {
      subscriptions?.dispose();
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("Starting TM1 MCP Server");

  const sessionManager = new SessionManager(config, logger);
  const tm1Client = new TM1Client(config, sessionManager, logger);

  if (config.mode === "readonly") {
    logger.info(
      "TM1_MODE=readonly — write and destructive tools will not be registered",
    );
  }
  if (config.mode === "sandbox") {
    logger.info(
      `TM1_MODE=sandbox — writes go only into sandboxes named "${config.sandboxPrefix}…"; base data is read-only`,
    );
  }

  // Branch on transport. stdio is the default for local MCP-client setups
  // (Claude Code, Claude Desktop) and gets one long-lived server. http
  // (Streamable HTTP, stateless) is for remote/multi-client deploys and builds a
  // fresh server per request (single-use transport); binds to 127.0.0.1 by
  // default with DNS-rebinding protection per MCP spec recommendation.
  // stdio builds exactly one server for the process lifetime, so its disposer
  // runs in shutdown(). http builds one per request and disposes each in the
  // transport's own teardown — nothing process-scoped is left for us here.
  let stdioDispose: (() => void) | undefined;
  const httpCloser =
    config.transport === "http"
      ? await startHttpTransport(
          () => buildMcpServer(tm1Client, config, logger),
          config,
          logger,
        )
      : await (async () => {
          const built = buildMcpServer(tm1Client, config, logger);
          stdioDispose = built.dispose;
          tm1Client.onSandboxingChange = built.recheckTools;
          return startStdioTransport(built.server, logger);
        })();
  logger.info(
    `MCP server configured (mode: ${config.mode}, transport: ${config.transport})`,
  );

  // Log in to TM1 in the background, after the transport is up: a TM1 that is
  // slow or down must not delay initialize and tools/list. A tool call that
  // arrives first shares this login (authenticate() dedupes), and one that
  // arrives after a failed login retries it through ensureSession().
  tm1Client.connect().then(
    () => logger.info("TM1 client connected"),
    (err: unknown) =>
      logger.warn(
        { err },
        "Initial TM1 connection failed — server will retry on first tool call",
      ),
  );

  // Graceful shutdown — ensure TM1 session is always cleaned up.
  let shuttingDown = false;
  const shutdown = async (signal?: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down TM1 MCP Server");
    try {
      stdioDispose?.();
    } catch (err) {
      logger.error({ err }, "Error disposing server subscriptions");
    }
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
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGHUP", () => {
    void shutdown("SIGHUP");
  });

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
    // Exit non-zero: a crash must not look like a clean shutdown to a
    // supervisor/systemd, which would otherwise not restart or would mask it.
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled rejection");
  });
}

main().catch((err) => {
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
