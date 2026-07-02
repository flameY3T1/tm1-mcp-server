import { describe, expect, it } from "vitest";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { asOutputSchema } from "../../src/tools/schemas/output-schema.js";

// Mirror how the MCP SDK publishes an outputSchema: for a ZodRawShape it wraps
// in `z.object(shape)`, for a full schema it uses it as-is, then converts with
// zod 4's native `z.toJSONSchema`. The SDK passes `pipeStrategy: "output"` for
// outputSchema conversion (see mcp.js), which maps to `io: "output"` — so we
// reproduce that here to get the exact JSON Schema clients receive.
function publishedJsonSchema(entry: ZodRawShape | ZodTypeAny): {
  additionalProperties?: boolean | object;
} {
  const schema =
    typeof entry === "object" && entry !== null && "_def" in (entry as object)
      ? (entry as ZodTypeAny)
      : z.object(entry as ZodRawShape);
  return z.toJSONSchema(schema, { io: "output" }) as {
    additionalProperties?: boolean | object;
  };
}

// Regression guard for `asOutputSchema`'s passthrough detection.
//
// asOutputSchema decides how to publish a Zod object as an MCP outputSchema:
//   - plain `z.object({...})`  -> return `.shape` (SDK rebuilds a strict
//     object, JSON Schema `additionalProperties: false`).
//   - `.passthrough()` object  -> return the full schema so the SDK preserves
//     `additionalProperties: true` and does not reject per-tool extras.
//
// Detection reads zod 4's `schema.def.catchall`. If a zod point release renamed
// or moved that field, the read would silently return `undefined`, every
// `.passthrough()` schema would be misclassified as plain, and clients would
// start rejecting legitimate extras with "data must NOT have additional
// properties". These tests fail loudly if that happens.

function isRawShape(entry: ZodRawShape | ZodTypeAny): boolean {
  // `.shape` is a plain record with no `_def`; a full schema is a ZodType.
  return !(
    typeof entry === "object" &&
    entry !== null &&
    "_def" in (entry as object)
  );
}

describe("asOutputSchema — passthrough detection", () => {
  it("returns the raw shape for a plain z.object", () => {
    const plain = z.object({ a: z.string(), b: z.number() });
    const result = asOutputSchema(plain);

    // Plain objects publish as ZodRawShape (`.shape`), not the full schema.
    expect(isRawShape(result)).toBe(true);
    expect(result).toBe(plain.shape);
  });

  it("returns the full schema for a .passthrough() object", () => {
    const loose = z.object({ a: z.string() }).passthrough();
    const result = asOutputSchema(loose);

    // Passthrough objects MUST be returned whole so the catchall survives.
    // If catchall detection silently broke (returned undefined), this would
    // instead be the raw shape and the assertion fails.
    expect(isRawShape(result)).toBe(false);
    expect(result).toBe(loose);
  });

  it("published JSON Schema has additionalProperties:false for plain objects", () => {
    const plain = z.object({ a: z.string() });
    const json = publishedJsonSchema(asOutputSchema(plain));
    expect(json.additionalProperties).toBe(false);
  });

  it("published JSON Schema permits extras for .passthrough() objects", () => {
    const loose = z.object({ a: z.string() }).passthrough();
    const json = publishedJsonSchema(asOutputSchema(loose));
    // A permissive object (`{}`) or `true` both allow extras; only an explicit
    // `false` is the failure mode that breaks clients validating extras.
    expect(json.additionalProperties).not.toBe(false);
    expect(json.additionalProperties).not.toBeUndefined();
  });

  it("catchall field exists on passthrough and is absent on plain (zod-shape guard)", () => {
    // Directly assert the internal contract asOutputSchema depends on, so a
    // zod release that moves `def.catchall` trips this test explicitly.
    const plain = z.object({ a: z.string() });
    const loose = z.object({ a: z.string() }).passthrough();
    expect(plain.def.catchall).toBeUndefined();
    expect(loose.def.catchall).not.toBeUndefined();
  });
});
