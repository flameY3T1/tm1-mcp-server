import type pino from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANNOTATION_MAP } from "./annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "./output-schema-map.js";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
  type McpToolResult,
} from "./error-format.js";

// Wrap McpServer so every server.tool(name, desc, schema, cb) call:
//   1) injects the matching annotation from ANNOTATION_MAP
//   2) wraps the callback so thrown errors become uniform JSON results
//      and existing isError results get reshaped to include `hint`
//   3) when OUTPUT_SCHEMA_MAP has an entry for the tool, attaches outputSchema
//   4) when mode="readonly", silently skips tools without readOnlyHint
export function withAnnotations(
  server: McpServer,
  logger: pino.Logger,
  mode: "readwrite" | "readonly",
): McpServer {
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

  const SLOW_TOOL_MS = 5000;

  const wrapCb = (
    toolName: string,
    cb: ToolCallback,
    hasOutputSchema: boolean,
  ): ToolCallback => {
    return async (...cbArgs: unknown[]) => {
      const start = Date.now();
      try {
        const result = (await cb(...cbArgs)) as McpToolResult | undefined;
        const durationMs = Date.now() - start;
        if (durationMs >= SLOW_TOOL_MS) {
          void server.server
            .sendLoggingMessage({
              level: "warning",
              logger: "tm1-mcp",
              data: {
                tool: toolName,
                durationMs,
                message: `slow tool call: ${toolName} took ${durationMs}ms`,
              },
            })
            .catch(() => undefined);
        }
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
        if (!isFourArg) {
          throw new Error(
            "withAnnotations Proxy expects server.tool(name, description, inputSchema, cb). " +
              "Other tool() overloads are deprecated and not supported here.",
          );
        }
        const name = args[0] as string;
        const description = args[1] as string;
        const inputSchema = args[2];
        const annot = ANNOTATION_MAP[name];
        if (!annot) {
          throw new Error(
            `Tool "${name}" registered without annotation — add it to ANNOTATION_MAP in src/tools/annotation-map.ts`,
          );
        }
        if (mode === "readonly" && !annot.readOnlyHint) {
          return;
        }
        const outputSchema = OUTPUT_SCHEMA_MAP[name];
        const wrappedCb = wrapCb(
          name,
          args[3] as ToolCallback,
          Boolean(outputSchema),
        );
        const config: Record<string, unknown> = {
          description,
          inputSchema,
          annotations: annot,
        };
        if (outputSchema) config.outputSchema = outputSchema;
        return originalRegisterTool(name, config, wrappedCb);
      };
    },
  }) as McpServer;
}
