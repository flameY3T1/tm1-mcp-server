// Output-schema wrapper for tools that offer `format: "markdown"`.
//
// Why this exists: clients that read `structuredContent` (Claude Code) discard
// the `content` array entirely, so a rendered Markdown table shipped only in
// `content` never reaches the model — `format:"markdown"` was a silent no-op
// there. The table therefore has to travel inside `structuredContent`, as
// `{ markdown: "<table>" }`.
//
// That collides with the declared outputSchema three ways, all measured
// against @modelcontextprotocol/sdk 1.30.0:
//   1. Omitting structuredContent is not allowed once an outputSchema exists —
//      the SDK answers `-32602 ... has an output schema but no structured
//      content was provided` (server/mcp.js, validateToolOutput).
//   2. Adding `markdown` alongside a strict payload is rejected client-side
//      with "must NOT have additional properties".
//   3. A `z.union` / `z.discriminatedUnion` outputSchema cannot express
//      "either shape": the SDK's zod-compat throws on the non-object schema
//      and then publishes NO outputSchema for the tool at all.
//
// So the schema handed to the SDK is `Payload.partial()` plus an optional
// `markdown`, which accepts both shapes. `.partial()` only relaxes TOP-LEVEL
// keys — nested objects and array items stay strict, which is where drift
// usually appears. The top-level strictness that is lost here is restored by
// the guard in ../with-annotations.ts, which picks the matching strict variant
// per response via `strictVariants()`.
import { z, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";

export interface StrictVariants {
  /** Full payload shape, exactly as before the loosening. */
  json: ZodTypeAny;
  /** The only shape a markdown response may take. */
  markdown: ZodTypeAny;
}

// Keyed by the loosened schema object we hand to the SDK. A WeakMap keeps the
// pairing out of the wire format — the SDK only ever sees plain Zod.
const VARIANTS = new WeakMap<object, StrictVariants>();

// Strict on purpose: a markdown response that also carries payload fields
// means a handler mixed the two paths, and the client the markdown was meant
// for would render the leaked JSON.
export const MARKDOWN_ONLY_SCHEMA = z.strictObject({
  markdown: z.string(),
});

function isZodSchema(entry: ZodRawShape | ZodTypeAny): entry is ZodTypeAny {
  return "_def" in entry;
}

/**
 * Widen an outputSchema so the tool may answer with either its full JSON
 * payload or `{ markdown }`. Use for every tool that accepts FORMAT_SCHEMA.
 */
export function markdownCapable(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  const strict = (
    isZodSchema(entry) ? entry : z.object(entry)
  ) as ZodObject<ZodRawShape>;
  const loose = strict.partial().extend({ markdown: z.string().optional() });
  VARIANTS.set(loose, { json: strict, markdown: MARKDOWN_ONLY_SCHEMA });
  return loose;
}

/**
 * Strict counterparts for a schema produced by `markdownCapable`, or undefined
 * for any other schema.
 */
export function strictVariants(
  entry: ZodRawShape | ZodTypeAny | object | undefined,
): StrictVariants | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  return VARIANTS.get(entry);
}
