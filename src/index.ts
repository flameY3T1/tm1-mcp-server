import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { TM1Client } from "./tm1-client.js";
import { registerAllTools } from "./tools/index.js";
import { NAME, VERSION } from "./version.js";

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

  // Create MCP server
  const server = new McpServer({
    name: NAME,
    version: VERSION,
  });

  // Register all tools
  registerAllTools(server, tm1Client);
  logger.info("All MCP tools registered");

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server listening on stdio");

  // Graceful shutdown — ensure TM1 session is always cleaned up.
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down TM1 MCP Server");
    try {
      await tm1Client.disconnect();
    } catch (err) {
      logger.error({ err }, "Error during disconnect");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // Parent process death — common for MCP stdio servers.
  process.stdin.on("end", () => {
    logger.info("stdin ended (parent process gone), shutting down");
    void shutdown("stdin-end");
  });
  process.stdin.on("close", () => {
    logger.info("stdin closed, shutting down");
    void shutdown("stdin-close");
  });

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
  // eslint-disable-next-line no-console
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
