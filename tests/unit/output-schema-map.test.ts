import { describe, expect, it } from "vitest";
import { z } from "zod";
import { paginate } from "../../src/tools/pagination.js";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";

// Minimal fixtures matching each item schema. Kept inline so the test fails
// loud if a schema field changes underneath us.
const SAMPLES: Record<string, unknown[]> = {
  tm1_list_cubes: [{ name: "Sales", dimensions: ["Region", "Period"] }],
  tm1_list_dimensions: [{ name: "Region", hierarchies: ["Region"] }],
  tm1_list_processes: [
    {
      name: "p1",
      parameters: [{ name: "p", type: "String", defaultValue: "x" }],
    },
  ],
  tm1_list_chores: [
    {
      name: "c1",
      active: true,
      startTime: "2026-01-01T00:00:00",
      frequency: "P1D",
      processes: [{ name: "p1", parameters: { region: "EU" } }],
    },
  ],
  tm1_list_clients: [{ Name: "admin", Enabled: true }],
  tm1_list_groups: [{ Name: "ADMIN", Clients: [{ Name: "admin" }] }],
  tm1_list_views: [{ name: "v1", private: false }],
  tm1_list_subsets: [
    {
      name: "s1",
      dimensionName: "Region",
      hierarchyName: "Region",
      private: false,
      elements: ["EU", "US"],
    },
  ],
  tm1_list_threads: [
    {
      id: 1,
      type: "User",
      name: "admin",
      state: "Idle",
      function: "",
      objectName: "",
    },
  ],
  tm1_list_sessions: [
    { id: "1", user: "admin", threads: [] },
  ],
  tm1_list_element_attributes: [
    { elementName: "EU", attributeName: "Currency", value: "EUR" },
  ],
};

describe("OUTPUT_SCHEMA_MAP", () => {
  it("declares output schemas for the 12 paginated list_* tools", () => {
    expect(Object.keys(OUTPUT_SCHEMA_MAP).sort()).toEqual(
      [
        "tm1_list_chores",
        "tm1_list_clients",
        "tm1_list_cubes",
        "tm1_list_dimensions",
        "tm1_list_element_attributes",
        "tm1_list_files",
        "tm1_list_groups",
        "tm1_list_processes",
        "tm1_list_sessions",
        "tm1_list_subsets",
        "tm1_list_threads",
        "tm1_list_views",
      ],
    );
  });

  for (const [toolName, items] of Object.entries(SAMPLES)) {
    it(`${toolName}: paginated output validates against schema`, () => {
      const shape = OUTPUT_SCHEMA_MAP[toolName];
      expect(shape, `missing schema for ${toolName}`).toBeDefined();
      const schema = z.object(shape);
      const page = paginate(items, 50, 0);
      const result = schema.safeParse(page);
      if (!result.success) {
        throw new Error(
          `${toolName} validation failed: ${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
    });
  }

  it("tm1_list_files: paginated output (with `path`) validates against schema", () => {
    const shape = OUTPUT_SCHEMA_MAP.tm1_list_files;
    const schema = z.object(shape);
    const payload = { path: "Subdir", ...paginate(["a.csv", "b.csv"], 50, 0) };
    const result = schema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
