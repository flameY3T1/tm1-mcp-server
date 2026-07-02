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
 * `def.catchall`. For plain `z.object({...})` it is undefined; for a
 * `.passthrough()` / `.catchall(...)` schema it is a Zod type.
 *
 * `.def` is zod 4's public, typed accessor for the schema definition (the
 * classic `ZodObject` types `.def` identically to the internal `._def`), so
 * no `_def` reach-in or `as unknown as` cast is needed. The exact-pinned zod
 * version (see package.json) plus the co-located regression test guard against
 * a point release changing this shape. Bump zod manually and re-run tests.
 */
export function asOutputSchema<T extends ZodObject<ZodRawShape>>(
  schema: T,
): ZodTypeAny | ZodRawShape {
  return schema.def.catchall != null ? schema : schema.shape;
}
