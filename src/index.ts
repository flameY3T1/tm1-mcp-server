import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { TM1Client } from "./tm1-client.js";
import { registerAllTools } from "./tools/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info("Starting TM1 MCP Server");

  const sessionManager = new SessionManager(config, logger);
  const tm1Client = new TM1Client(config, sessionManager, logger);

  // Connect to TM1 (authenticate + start keep-alive)
  await tm1Client.connect();
  logger.info("TM1 client connected");

  // Create MCP server
  const server = new McpServer({
    name: "tm1-mcp-server",
    version: "1.0.0",
  });

  // Register all tools
  registerAllTools(server, tm1Client);
  logger.info("All MCP tools registered");

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server listening on stdio");

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down TM1 MCP Server");
    try {
      await tm1Client.disconnect();
    } catch (err) {
      logger.error({ err }, "Error during disconnect");
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
