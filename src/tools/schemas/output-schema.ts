import type { ZodObject, ZodRawShape, ZodTypeAny } from "zod";

/**
 * Return the correct MCP outputSchema representation for a Zod object.
 *
 * Schemas built with `.passthrough()` / `.catchall(...)` MUST be published
 * as full ZodTypeAny so the SDK preserves `additionalProperties: true` in
 * the generated JSON Schema. Extracting `.shape` from such a schema silently
 * loses the flag and makes the SDK reject legitimate per-tool extras with
 * "data must NOT have additional properties".
 *
 * Plain object schemas are passed as ZodRawShape (`.shape`) per SDK convention.
 *
 * Detection: zod 4 stores the catchall/passthrough fallback under
 * `_def.catchall`. For plain `z.object({...})` it is undefined.
 */
export function asOutputSchema<T extends ZodObject<ZodRawShape>>(
  schema: T,
): ZodTypeAny | ZodRawShape {
  const def = (schema as unknown as { _def?: { catchall?: unknown } })._def;
  return def && def.catchall != null ? schema : schema.shape;
}
