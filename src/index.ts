import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type pino from "pino";
import { loadConfig, type TM1Config } from "./config.js";
import { createLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { TM1Client } from "./tm1-client.js";
import { ANNOTATION_MAP } from "./tools/annotation-map.js";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
  type McpToolResult,
} from "./tools/error-format.js";
import { registerAllPrompts } from "./prompts/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllTools } from "./tools/index.js";
import { OUTPUT_SCHEMA_MAP } from "./tools/output-schema-map.js";
import { NAME, VERSION } from "./version.js";

// Wrap McpServer so every server.tool(name, desc, schema, cb) call:
//   1) injects the matching annotation from ANNOTATION_MAP via SDK 5-arg
//      overload (audit gap 1)
//   2) wraps the callback so thrown errors become uniform JSON results
//      and existing isError results get reshaped to include `hint`
//      (audit gaps 5 + 6)
//   3) when OUTPUT_SCHEMA_MAP has an entry for the tool, routes the
//      registration through `server.registerTool` so the SDK can publish
//      `outputSchema` to clients, and parses the JSON text body back into
//      `structuredContent` for typed consumption (audit gap 2)
// Centralized so we don't touch 84 register* call sites.
function withAnnotations(server: McpServer, logger: pino.Logger): McpServer {
  const originalTool = server.tool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;

  type ToolCallback = (...cbArgs: unknown[]) => Promise<unknown> | unknown;

  const attachStructured = (result: McpToolResult): McpToolResult => {
    const first = result.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      return result;
    }
    const raw = first.text.trim();
    if (!raw.startsWith("{") && !raw.startsWith("[")) return result;
    try {
      const parsed = JSON.parse(raw);
      return { ...result, structuredContent: parsed };
    } catch {
      return result;
    }
  };

  const wrapCb = (
    toolName: string,
    cb: ToolCallback,
    hasOutputSchema: boolean,
  ): ToolCallback => {
    return async (...cbArgs: unknown[]) => {
      try {
        const result = (await cb(...cbArgs)) as McpToolResult | undefined;
        if (result && result.isError) {
          return normalizeErrorResult(result);
        }
        if (result && hasOutputSchema) {
          return attachStructured(result);
        }
        return result;
      } catch (err) {
        logger.error({ err, tool: toolName }, "Tool handler threw");
        return formatTm1ErrorResult(err);
      }
    };
  };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") return Reflect.get(target, prop, receiver);
      return (...args: unknown[]) => {
        const isFourArg =
          args.length === 4 &&
          typeof args[0] === "string" &&
          typeof args[1] === "string" &&
          typeof args[3] === "function";
        if (isFourArg) {
          const name = args[0] as string;
          const description = args[1] as string;
          const inputSchema = args[2];
          const annot = ANNOTATION_MAP[name];
          const outputSchema = OUTPUT_SCHEMA_MAP[name];
          const wrappedCb = wrapCb(
            name,
            args[3] as ToolCallback,
            Boolean(outputSchema),
          );

          if (outputSchema) {
            // registerTool publishes outputSchema to clients; the wrapped
            // callback parses the existing text body into structuredContent
            // so call sites stay unchanged.
            const config: Record<string, unknown> = {
              description,
              inputSchema,
              outputSchema,
            };
            if (annot) config.annotations = annot;
            return originalRegisterTool(name, config, wrappedCb);
          }

          if (annot) {
            return originalTool(name, description, inputSchema, annot, wrappedCb);
          }
          throw new Error(
            `Tool "${name}" registered without annotation — add it to ANNOTATION_MAP in src/tools/annotation-map.ts`,
          );
        }
        return originalTool(...args);
      };
    },
  }) as McpServer;
}

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
    sessionIdGenerator: undefined, // stateless mode
    enableDnsRebindingProtection: true,
    allowedHosts: [allowedHost, "127.0.0.1", "localhost"],
  });
  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Not found. Use POST /mcp." }));
      return;
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
    { host: config.httpHost, port: config.httpPort, endpoint: "/mcp" },
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

  // Create MCP server
  const server = new McpServer({
    name: NAME,
    version: VERSION,
  });

  // Register all tools — wrap server so each registration receives the
  // annotation hint from ANNOTATION_MAP without editing call sites.
  registerAllTools(withAnnotations(server, logger), tm1Client);
  logger.info("All MCP tools registered");

  // Register MCP Resources (URI-addressable read-only views over TM1
  // objects). Mirrors a subset of the get_* tool surface so IDE clients
  // can `#`-reference TM1 objects in chat or browse a sidebar tree.
  registerAllResources(server, tm1Client);
  logger.info("All MCP resources registered");

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

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

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
  // eslint-disable-next-line no-console
  console.error("Fatal error starting TM1 MCP Server:", err);
  process.exit(1);
});
