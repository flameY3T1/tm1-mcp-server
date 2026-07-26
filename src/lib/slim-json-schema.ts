/**
 * Strip information-free noise from a serialized JSON Schema.
 *
 * Zod's JSON-Schema emitter spells `.int()` out as the JS safe-integer range
 * (`minimum: -9007199254740991` / `maximum: 9007199254740991`) and stamps a
 * `$schema` dialect header onto every root. Both ship on every `tools/list`
 * response and tell a model exactly nothing — together they account for ~25KB
 * across the tool surface. Removing them is lossless: runtime validation still
 * happens against the Zod objects server-side, which are untouched.
 *
 * The strip is deliberately narrow. A `minimum`/`maximum` is dropped ONLY when
 * its value is the exact sentinel, so real bounds (`limit` max 500, `offset`
 * min 0) survive. And keyword rules are suspended inside name-keyed containers
 * (`properties` & friends), where the keys are user-chosen field names — a tool
 * with a field literally called `$schema` keeps its subschema.
 *
 * Pure: the input is never mutated, the result is a fresh deep clone.
 */

// Zod serializes `.int()` to the JS safe-integer range; these two exact values
// are the sentinel, anything else is a real, author-chosen bound.
const SAFE_INT_MIN = -9007199254740991; // Number.MIN_SAFE_INTEGER
const SAFE_INT_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER

// JSON-Schema containers whose immediate keys are field names, not keywords.
// Recursion must not apply the strip rules one level below these.
const NAME_KEYED_CONTAINERS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

export function slimJsonSchema(schema: unknown): unknown {
  return slimNode(schema, false);
}

// `nameKeyed` = this node is a map of field-name → subschema, so its own keys
// carry no keyword meaning and must be preserved verbatim.
function slimNode(node: unknown, nameKeyed: boolean): unknown {
  if (Array.isArray(node)) return node.map((entry) => slimNode(entry, false));
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!nameKeyed) {
      if (key === "$schema") continue;
      if (key === "minimum" && value === SAFE_INT_MIN) continue;
      if (key === "maximum" && value === SAFE_INT_MAX) continue;
    }
    const slimmed = slimNode(
      value,
      !nameKeyed && NAME_KEYED_CONTAINERS.has(key),
    );
    // A field named `__proto__` would otherwise mutate the prototype chain
    // instead of becoming an own property.
    if (key === "__proto__") {
      Object.defineProperty(out, key, {
        value: slimmed,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      continue;
    }
    out[key] = slimmed;
  }
  return out;
}
