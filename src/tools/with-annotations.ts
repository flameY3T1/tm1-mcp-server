import type pino from "pino";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { slimJsonSchema } from "../lib/slim-json-schema.js";
import { ANNOTATION_MAP } from "./annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "./output-schema-map.js";
import { strictVariants } from "./schemas/markdown-capable.js";
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

// A markdown response carries exactly one key. Anything else is the JSON path.
function isMarkdownPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "markdown" &&
    typeof (value as { markdown: unknown }).markdown === "string"
  );
}

// Rewrite a tools/list response so every advertised schema is slimmed.
function slimToolsListResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const listing = result as { tools?: unknown };
  if (!Array.isArray(listing.tools)) return result;
  return {
    ...listing,
    tools: listing.tools.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const tool: Record<string, unknown> = {
        ...(entry as Record<string, unknown>),
      };
      if (tool.inputSchema !== undefined) {
        tool.inputSchema = slimJsonSchema(tool.inputSchema);
      }
      if (tool.outputSchema !== undefined) {
        tool.outputSchema = slimJsonSchema(tool.outputSchema);
      }
      return tool;
    }),
  };
}

// SDK REACH — isolated here on purpose.
//
// The zod→JSON-Schema conversion happens inside the SDK: McpServer's
// setToolRequestHandlers() serializes tool.inputSchema/outputSchema at
// tools/list time, and it is installed lazily on the FIRST registerTool call.
// There is no public hook between that conversion and the wire, so the only
// place to slim the payload is the tools/list handler itself.
//
// Rather than dig into the handler registry (a private Map), we intercept the
// SDK's own `setRequestHandler` call on the low-level Server and wrap the
// handler it is trying to install. Public method, public request schema
// (imported from the SDK, matched by reference — same module instance the SDK
// itself imports), no private state touched. Must be installed BEFORE the first
// tool registration, which is why it runs inside withAnnotations().
//
// If a future SDK stops routing tools/list through setRequestHandler, or hands
// it a different schema object, this becomes a silent no-op — the sentinels
// would simply reappear on the wire. tests/unit/slim-json-schema.test.ts does a
// real end-to-end tools/list over an in-memory transport and fails loudly in
// that case.
function installToolsListSlimming(server: McpServer): void {
  const lowLevel = server.server as unknown as {
    setRequestHandler: (
      schema: unknown,
      handler: (...args: unknown[]) => unknown,
    ) => void;
  };
  const originalSetRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);
  lowLevel.setRequestHandler = (schema, handler) => {
    if (schema !== ListToolsRequestSchema) {
      originalSetRequestHandler(schema, handler);
      return;
    }
    originalSetRequestHandler(schema, async (...args: unknown[]) =>
      slimToolsListResult(await handler(...args)),
    );
  };
}

// Wrap McpServer so every server.tool(name, desc, schema, cb) call:
//   1) injects the matching annotation from ANNOTATION_MAP
//   2) wraps the callback so thrown errors become uniform JSON results
//      and existing isError results get reshaped to include `hint`
//   3) when OUTPUT_SCHEMA_MAP has an entry for the tool, attaches outputSchema
//   4) when mode="readonly", silently skips tools without readOnlyHint
// Also installs the tools/list schema slimmer (see installToolsListSlimming) —
// it has to be in place before the first registration triggers the SDK's lazy
// handler setup.
export function withAnnotations(
  server: McpServer,
  logger: pino.Logger,
  mode: "readwrite" | "readonly",
  // Matches the shipped default (config.responseMode, see config.ts), so direct
  // callers — the live harness and the unit tests, which read content[0].text —
  // exercise the same wire shape real clients get.
  responseMode: "legacy" | "structured" = "legacy",
): McpServer {
  installToolsListSlimming(server);

  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;

  type ToolCallback = (...cbArgs: unknown[]) => unknown;

  // Handlers return their payload as a JSON string in content[0].text. Parsing
  // it into structuredContent is what satisfies the declared outputSchema — but
  // leaving the text block in place means the identical JSON crosses the wire
  // TWICE. Every tool declares an outputSchema, so in "legacy" mode that
  // doubling applies to every successful response.
  //
  // In "structured" mode the now-redundant text block is dropped. That is
  // spec-legal only because an outputSchema is declared: CallToolResult.content
  // "may be empty" then (see CallToolResultSchema in the SDK). It is NOT the
  // default, and must not become one — the spec says a tool returning
  // structured content SHOULD also return the serialized JSON in a TextContent
  // block, and clients take that literally. Kiro's MCP layer (bundled TS SDK,
  // protocolVersion 2025-11-25, clientInfo {name:"kiro"}) parses results with
  //   const items = Array.isArray(r.content) ? r.content : []
  // and never reads structuredContent, so an empty content array renders as no
  // output at all.
  //
  // Dropping the text block also buys nothing on the clients that do read
  // structuredContent: Claude Code de-duplicates, so an identical payload sent
  // both ways costs exactly one copy of context (measured byte-identical
  // tool_result at 1 KB and at 23 KB, and the >25k-token offload-to-file path
  // behaves the same either way). The saving is real only for clients that
  // serialize the whole CallToolResult into the model prompt — Q DEV CLI /
  // Kiro CLI do this — which is who this mode is still here for.
  //
  // A non-JSON text block (markdown mode, where the handler already attached
  // structuredContent itself) is left alone in both modes: there the text is
  // the point, not a duplicate.
  const attachStructured = (result: McpToolResult): McpToolResult => {
    const first = result.content?.[0];
    if (!first || first.type !== "text" || typeof first.text !== "string") {
      return result;
    }
    const raw = first.text.trim();
    if (!raw.startsWith("{") && !raw.startsWith("[")) return result;
    try {
      const parsed = JSON.parse(raw);
      return responseMode === "structured"
        ? { ...result, content: [], structuredContent: parsed }
        : { ...result, structuredContent: parsed };
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
    // Tools offering format:"markdown" publish a loosened schema (top-level
    // keys optional, plus `markdown`) because the SDK cannot express "either
    // shape" — see ./schemas/markdown-capable.ts. Validating against that
    // loosened schema would forfeit top-level drift detection on the JSON
    // path, so we pick the matching strict variant per response instead.
    const variants = strictVariants(outputSchema);
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
            //
            // Variant pick is made from the RESPONSE, not from the requested
            // `format`: a handler may legitimately fall back to JSON while
            // format:"markdown" was asked for (unavailable stats, empty
            // result), and branching on the input would reject that. No JSON
            // payload in OUTPUT_SCHEMA_MAP carries a top-level `markdown`
            // string, so the discriminator is unambiguous.
            const effectiveSchema = variants
              ? isMarkdownPayload(withStructured.structuredContent)
                ? variants.markdown
                : variants.json
              : schema;
            const parsed = effectiveSchema.safeParse(
              withStructured.structuredContent,
            );
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
