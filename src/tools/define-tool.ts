// Single-site tool definition.
//
// Historically a tool's metadata lived in four places: the `server.tool(...)`
// call in its own file, an entry in ANNOTATION_MAP, an entry in
// OUTPUT_SCHEMA_MAP, and (for format-capable tools) a name in
// MARKDOWN_CAPABLE_TOOLS. Four of the repo's lint gates exist only to keep
// those name-keyed maps in step with the registrations. `defineTool` collapses
// the four into one literal at the definition site; the maps become fallbacks
// for the not-yet-migrated tools and shrink to nothing as migration proceeds.
//
// Migration is file-by-file on purpose. A `defineTool` tool still registers
// through the same `server.tool(name, description, input, cb)` call the Proxy
// in ./with-annotations.ts intercepts — nothing about the wrapping, error
// normalization, readonly filtering or structuredContent handling changes.
// The Proxy simply looks the spec up here first (see `specFor`) and falls back
// to the maps when there is none.
//
// Two things the maps required by hand are now DERIVED and can no longer drift:
//   - markdown capability: an input shape carrying `format` (i.e. one that
//     spread FORMAT_SCHEMA) gets `markdownCapable()` applied to its output
//     schema automatically — no MARKDOWN_CAPABLE_TOOLS membership to forget.
//   - passthrough handling: a full ZodObject output is routed through
//     `asOutputSchema()`, so `.passthrough()` / `.catchall()` schemas keep
//     `additionalProperties: true` without the caller remembering the helper.
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod";
import type { TM1Client } from "../tm1-client.js";
import type { Tm1ToolAnnotations } from "./annotations.js";
import { asOutputSchema } from "./schemas/output-schema.js";
import { markdownCapable } from "./schemas/markdown-capable.js";

/** Registrar shape expected by the REGISTRARS array in ./index.ts. */
export type ToolRegistrar = (server: McpServer, tm1Client: TM1Client) => void;

export interface ToolSpec<I extends ZodRawShape> {
  /** Wire name, `tm1_*`. */
  name: string;
  /**
   * Tool description. An array is joined with a single space — the same shape
   * the hand-written registrations use, and what scripts/lib/scan-tools.mjs
   * parses for docs/TOOLS.md.
   */
  description: string | readonly string[];
  /** Zod raw shape for the tool's arguments. */
  input: I;
  /**
   * Output payload schema, pre-widening. Pass the plain schema or raw shape;
   * `asOutputSchema()` and `markdownCapable()` are applied here as needed.
   * Omit for tools that answer with unstructured text.
   */
  output?: ZodObject<ZodRawShape> | ZodRawShape;
  /** MCP behavior hints — one of the presets in ./annotations.js. */
  annotations: Tm1ToolAnnotations;
  /**
   * Registration gate for tools that exist on one TM1 generation only (v11
   * threads vs v12 jobs, v11-only save_data). Returning false skips the tool
   * entirely — it never appears in tools/list. This is deliberately separate
   * from the `requiresVersion` annotation, which is a client-facing HINT and
   * is also carried by tools that stay registered on both generations.
   */
  enabled?: (tm1Client: TM1Client) => boolean;
  /**
   * Set on a writing tool that confines itself to a sandbox when the server
   * runs with TM1_MODE=sandbox (the handler enforces it through
   * ../lib/sandbox-policy.ts). Only such tools, besides the read-only ones,
   * are registered in sandbox mode; every other writing tool is left out.
   */
  sandboxScoped?: true;
  /**
   * Handler. Receives the parsed args, the shared TM1 client, and the SDK's
   * per-call extra (abort signal, request metadata).
   */
  handler: (
    args: Parameters<ToolCallback<I>>[0],
    tm1Client: TM1Client,
    extra: Parameters<ToolCallback<I>>[1],
  ) => ReturnType<ToolCallback<I>>;
}

/** What ./with-annotations.ts needs at registration time. */
export interface ResolvedSpec {
  name: string;
  annotations: Tm1ToolAnnotations;
  /** See ToolSpec.sandboxScoped. */
  sandboxScoped?: true;
  /** Already widened — hand straight to the SDK. */
  outputSchema?: ZodRawShape | ZodTypeAny;
}

// Populated at module-load time, when a tool file's top-level defineTool()
// call runs. That is strictly before registerAllTools() executes, because the
// import graph resolves first — so the Proxy always finds the spec.
const SPECS = new Map<string, ResolvedSpec>();

export function specFor(name: string): ResolvedSpec | undefined {
  return SPECS.get(name);
}

/** Every spec defined so far. Used by the lint gates and by tests. */
export function allSpecs(): ReadonlyMap<string, ResolvedSpec> {
  return SPECS;
}

function isZodObject(
  output: ZodObject<ZodRawShape> | ZodRawShape,
): output is ZodObject<ZodRawShape> {
  return "_def" in output;
}

function resolveOutput(
  output: ZodObject<ZodRawShape> | ZodRawShape | undefined,
  formatCapable: boolean,
): ZodRawShape | ZodTypeAny | undefined {
  if (output === undefined) return undefined;
  const normalized = isZodObject(output) ? asOutputSchema(output) : output;
  return formatCapable ? markdownCapable(normalized) : normalized;
}

export function defineTool<I extends ZodRawShape>(
  spec: ToolSpec<I>,
): ToolRegistrar {
  const description = Array.isArray(spec.description)
    ? spec.description.join(" ")
    : (spec.description as string);

  const existing = SPECS.get(spec.name);
  if (existing) {
    throw new Error(
      `defineTool: duplicate tool name "${spec.name}" — each tool may be defined once.`,
    );
  }

  const outputSchema = resolveOutput(spec.output, "format" in spec.input);
  SPECS.set(spec.name, {
    name: spec.name,
    annotations: spec.annotations,
    ...(spec.sandboxScoped ? { sandboxScoped: true as const } : {}),
    // Built conditionally: exactOptionalPropertyTypes rejects an explicit
    // `outputSchema: undefined` for an optional property.
    ...(outputSchema === undefined ? {} : { outputSchema }),
  });

  return (server, tm1Client) => {
    if (spec.enabled && !spec.enabled(tm1Client)) return;
    // ToolCallback<I> is a conditional type over an unresolved generic, so TS
    // cannot check the lambda against it — the cast asserts what the
    // ToolSpec.handler signature already pins down (same args, same return).
    const cb = ((
      args: Parameters<ToolCallback<I>>[0],
      extra: Parameters<ToolCallback<I>>[1],
    ) => spec.handler(args, tm1Client, extra)) as unknown as ToolCallback<I>;
    server.tool(spec.name, description, spec.input, cb);
  };
}
