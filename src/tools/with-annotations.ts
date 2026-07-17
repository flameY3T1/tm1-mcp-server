import type pino from "pino";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { ANNOTATION_MAP } from "./annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "./output-schema-map.js";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
  type McpToolResult,
} from "./error-format.js";

// Words whose display casing differs from simple capitalization.
const TITLE_CASING: Record<string, string> = {
  mdx: "MDX",
  ti: "TI",
  v12: "v12",
  v11: "v11",
};

// Derive a human-readable title from a snake_case tool name:
// "tm1_get_process_code" → "Get Process Code". Single point of derivation —
// no per-tool overrides in ANNOTATION_MAP.
export function deriveTitle(toolName: string): string {
  return toolName
    .replace(/^tm1_/, "")
    .split("_")
    .filter((w) => w.length > 0)
    .map((w) => TITLE_CASING[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// OUTPUT_SCHEMA_MAP entries are either a raw shape or a full Zod schema
// (passthrough/catchall). Normalize to a parseable schema.
function isZodSchema(entry: ZodRawShape | ZodTypeAny): entry is ZodTypeAny {
  return "_def" in entry;
}

function asZodSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return isZodSchema(entry) ? entry : z.object(entry);
}

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

  type ToolCallback = (...cbArgs: unknown[]) => unknown;

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
    outputSchema: ZodRawShape | ZodTypeAny | undefined,
  ): ToolCallback => {
    // Normalize once per tool, not per call.
    const schema = outputSchema ? asZodSchema(outputSchema) : undefined;
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
        if (result && schema) {
          const withStructured = attachStructured(result);
          if (withStructured.structuredContent !== undefined) {
            // Pre-validate against the outputSchema HERE so drift surfaces as
            // a graceful isError result. The SDK validates structuredContent
            // AFTER the callback returns and turns a mismatch into a raw
            // JSON-RPC protocol error; it skips that validation for isError
            // results (validateToolOutput returns early on result.isError),
            // so the error envelope below — which carries no
            // structuredContent — passes through cleanly.
            //
            // COVERAGE BOUNDARY: this guard only bites schemas that can actually
            // fail safeParse. A `.passthrough()` object or a `z.unknown()` field
            // accepts anything, so tools whose OUTPUT_SCHEMA_MAP entry is
            // permissive (e.g. MutationResultSchema.passthrough(), audit/feeder
            // schemas) get no structural drift protection here — extra/renamed
            // fields slip through silently. Prefer a strict, fully-modelled
            // schema for any new output whose shape you want enforced (the
            // callgraph tree was tightened for exactly this reason).
            const parsed = schema.safeParse(withStructured.structuredContent);
            if (!parsed.success) {
              const issue = parsed.error.issues[0];
              const detail = issue
                ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
                : "unknown issue";
              logger.warn(
                { tool: toolName, issues: parsed.error.issues.slice(0, 5) },
                "output schema drift",
              );
              return formatTm1ErrorResult(
                new Error(`output schema drift in ${toolName}: ${detail}`),
              );
            }
          }
          return withStructured;
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
        const wrappedCb = wrapCb(name, args[3] as ToolCallback, outputSchema);
        const config: Record<string, unknown> = {
          title: deriveTitle(name),
          description,
          inputSchema,
          annotations: annot,
        };
        if (outputSchema) config.outputSchema = outputSchema;
        return originalRegisterTool(name, config, wrappedCb);
      };
    },
  });
}
