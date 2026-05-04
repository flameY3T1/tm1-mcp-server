import { describe, expect, it } from "vitest";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";

// Regression guard for the "data must NOT have additional properties" bug.
//
// Several mutation tools return more fields than their MutationResultSchema
// envelope explicitly lists (e.g. processName, parameterCount, updatedTabs).
// MutationResultSchema is declared with `.passthrough()` to allow this, but
// extracting `.shape` discarded the passthrough flag. The SDK then rebuilt
// a strict z.object(), and the published JSON Schema set
// `additionalProperties: false` — causing the client to reject every call.
//
// This test asserts that for tools whose runtime payload includes extras,
// the published JSON Schema must allow additional properties.

function asSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return typeof entry === "object" && entry !== null && "_def" in entry
    ? (entry as ZodTypeAny)
    : z.object(entry as ZodRawShape);
}

const TOOLS_WITH_EXTRAS: string[] = [
  // Mutation envelope (success + per-tool extras)
  "tm1_assign_client_group",
  "tm1_cancel_thread",
  "tm1_clear_cube",
  "tm1_create_chore",
  "tm1_create_client",
  "tm1_create_element",
  "tm1_create_element_attribute",
  "tm1_create_process",
  "tm1_create_subset",
  "tm1_delete_element",
  "tm1_delete_process",
  "tm1_delete_subset",
  "tm1_move_element",
  "tm1_update_element",
  "tm1_update_element_attribute_value",
  "tm1_update_process_code",
  "tm1_update_process_datasource",
  "tm1_update_process_parameters",
  "tm1_update_process_variables",
  "tm1_update_subset",
  "tm1_write_cells",
  // Bespoke schemas that also rely on .passthrough()
  "tm1_upsert_process",
  "tm1_diff_process_with_file",
  "tm1_install_pro_bundle",
  "tm1_check_writable_coords",
  "tm1_get_process_datasource",
  "tm1_get_client",
  "tm1_get_server_info",
  "tm1_analyze_callgraph",
];

describe("OUTPUT_SCHEMA_MAP — JSON Schema additionalProperties", () => {
  for (const toolName of TOOLS_WITH_EXTRAS) {
    it(`${toolName}: published JSON Schema permits additional properties`, () => {
      const entry = OUTPUT_SCHEMA_MAP[toolName];
      expect(entry, `missing schema for ${toolName}`).toBeDefined();
      const schema = asSchema(entry);
      const json = zodToJsonSchema(schema, { strictUnions: true }) as {
        additionalProperties?: boolean | object;
      };
      // additionalProperties may be either `true` or an object schema (both
      // permit extras); only an explicit `false` is the failure mode.
      expect(
        json.additionalProperties,
        `${toolName}: JSON Schema rejects extras (additionalProperties=false). ` +
          `This breaks clients that strictly validate structuredContent.`,
      ).not.toBe(false);
    });
  }
});
