import { describe, expect, it, vi } from "vitest";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { paginate } from "../../src/tools/pagination.js";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";

// OUTPUT_SCHEMA_MAP entries are either a ZodRawShape (legacy) or a full
// ZodTypeAny (used when the schema relies on .passthrough() / .catchall(),
// since `.shape` extraction would discard those flags). Wrap shapes back into
// an object schema for parsing; pass full schemas through unchanged.
function asSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return typeof entry === "object" && entry !== null && "_def" in entry
    ? (entry as ZodTypeAny)
    : z.object(entry as ZodRawShape);
}

// Minimal fixtures matching each item schema. Kept inline so the test fails
// loud if a schema field changes underneath us.
const SAMPLES: Record<string, unknown[]> = {
  tm1_list_cubes: [{ name: "Sales", dimensions: ["Region", "Period"] }],
  tm1_list_dimensions: [
    { name: "Region", hierarchies: ["Region"] },
    // Validates the optional `elementCounts` field surfaces under includeElementCount=true.
    { name: "Period", hierarchies: ["Period"], elementCounts: { Period: 24 } },
  ],
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
    { name: "Currency", type: "String" },
  ],
};

const mockLogger = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  level: "silent", flush: vi.fn(),
} as unknown as pino.Logger;

function registeredToolNames(): Set<string> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const names = new Set<string>();
  const orig = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    names.add(args[0] as string);
    return (orig as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof server.registerTool>;
  };
  registerAllTools(withAnnotations(server, mockLogger, "readwrite"), {} as TM1Client);
  return names;
}

describe("OUTPUT_SCHEMA_MAP", () => {
  it("every OUTPUT_SCHEMA_MAP key is a registered tool (no orphaned schemas)", () => {
    const registered = registeredToolNames();
    const orphans = Object.keys(OUTPUT_SCHEMA_MAP).filter((k) => !registered.has(k));
    expect(orphans).toEqual([]);
  });

  for (const [toolName, items] of Object.entries(SAMPLES)) {
    it(`${toolName}: paginated output validates against schema`, () => {
      const entry = OUTPUT_SCHEMA_MAP[toolName];
      expect(entry, `missing schema for ${toolName}`).toBeDefined();
      const schema = asSchema(entry);
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
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_list_files);
    const payload = { path: "Subdir", ...paginate(["a.csv", "b.csv"], 50, 0) };
    const result = schema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it("tm1_list_sessions: compact-mode summary output validates against schema", () => {
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_list_sessions);
    const payload = {
      total: 3,
      count: 0,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [],
      summary: { namedUsers: 2, anonymousCount: 1 },
    };
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new Error(`compact validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
  });

  // ── Phase 2 fixtures ────────────────────────────────────────────────────
  const PHASE2_SAMPLES: Record<string, unknown> = {
    tm1_check_writable_coords: {
      cube: "Sales",
      writable: true,
      allElementsExist: true,
      allElementsNLevel: true,
      coords: [],
    },
    tm1_validate_process_refs: {
      processName: "Load.Sales",
      cubeRefsScanned: 3,
      dimensionRefsScanned: 5,
      unresolved: 0,
      issues: [],
    },
    tm1_get_subset: {
      name: "EU",
      dimensionName: "Region",
      hierarchyName: "Region",
      private: false,
      elements: ["DE", "FR"],
    },
    tm1_get_view: {
      cubeName: "Sales",
      viewName: "Default",
      axes: [
        {
          tuples: [
            { members: [{ name: "EU", hierarchyName: "Region" }] },
          ],
        },
      ],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ value: 100, formattedValue: "100.00" }],
    },
    tm1_get_hierarchy: {
      name: "Region",
      dimensionName: "Region",
      elements: [
        {
          name: "EU",
          type: "Consolidated",
          level: 1,
          parents: [],
          children: [{ name: "DE", weight: 1 }],
        },
      ],
      truncated: false,
    },
    tm1_get_descendants: {
      element: "EU",
      descendants: [{ name: "DE", type: "Numeric", level: 0, depth: 1 }],
      truncated: false,
    },
    tm1_get_process: {
      name: "Load.Sales",
      prolog: "# pro",
      metadata: "",
      data: "",
      epilog: "",
      parameters: [{ name: "pYear", type: "String", defaultValue: "2026" }],
      variables: [{ name: "vAmount", type: "Numeric", position: 1 }],
      dataSource: { type: "None" },
      hasSecurityAccess: false,
    },
    tm1_get_process_code: {
      prolog: "# pro",
      metadata: "",
      data: "",
      epilog: "",
    },
    tm1_get_process_datasource: { type: "None" },
    tm1_get_cell_value: { value: 42 },
    tm1_get_all_cube_rules: {
      count: 1,
      returned: 1,
      truncated: false,
      cubes: [{ cubeName: "Sales", rulesText: "[]=N:1;", skipCheck: false }],
    },
    tm1_get_all_processes_code: { count: 0, processes: [] },
    tm1_get_element_attribute_values: {
      dimensionName: "Region",
      elementName: "EU",
      attributes: [
        { elementName: "EU", attributeName: "Currency", value: "EUR" },
      ],
    },
    tm1_execute_mdx: {
      axes: [
        {
          tuples: [
            { members: [{ name: "EU", hierarchyName: "Region" }] },
          ],
        },
      ],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ value: 100, formattedValue: "100.00" }],
    },
    tm1_execute_process: {
      success: true,
      processErrorStatus: "CompletedSuccessfully",
    },
    tm1_diff_process_with_file: {
      processName: "Load.Sales",
      identical: true,
      tabs: [],
      parameters: [],
      variables: [],
      dataSource: [],
    },
    tm1_upsert_process: {
      processName: "Load.Sales",
      action: "updated",
      appliedSteps: ["compile", "save"],
    },
    tm1_install_pro_bundle: {
      directory: "bundle/",
      filesFound: 2,
      dryRun: false,
      mode: "upsert",
      counts: {
        created: 1,
        updated: 1,
        preflight_failed: 0,
        error: 0,
        skipped: 0,
      },
      results: [
        { file: "a.pro", processName: "A", status: "created" },
        { file: "b.pro", processName: "B", status: "updated" },
        { file: "c.pro", processName: null, status: "preflight_failed" },
      ],
    },
    tm1_import_pro_file: {
      action: "created",
      processName: "Load.Sales",
      parsed: {
        prologLines: 5,
        metadataLines: 0,
        dataLines: 10,
        epilogLines: 2,
        parameterCount: 1,
        variableCount: 3,
        dataSourceType: "ASCII",
      },
    },
    tm1_export_process_to_git: {
      processName: "Load.Sales",
      jsonFileName: "Load.Sales.json",
      tiFileName: "Load.Sales.ti",
      parameterCount: 1,
      variableCount: 3,
      dataSourceType: "ASCII",
      credentialsOmitted: false,
      hasSecurityAccess: false,
      writtenTo: { json: null, ti: null },
      json: '{\n  "name": "Load.Sales",\n  "parameters": [],\n  "variables": [],\n  "dataSource": { "type": "ASCII" }\n}\n',
      ti: "### TM1-TI-TAB: prolog ###\nsX=1;\n### TM1-TI-TAB: metadata ###\n### TM1-TI-TAB: data ###\n### TM1-TI-TAB: epilog ###\n",
    },
    tm1_import_process_from_git: {
      action: "created",
      processName: "Load.Sales",
      hasSecurityAccess: false,
      parsed: {
        prologLines: 5,
        metadataLines: 0,
        dataLines: 10,
        epilogLines: 2,
        parameterCount: 1,
        variableCount: 3,
        dataSourceType: "ASCII",
      },
    },
    tm1_copy_process: {
      success: true,
      sourceName: "Load.Sales",
      targetName: "Load.Sales.Copy",
    },
    tm1_analyze_callgraph: {
      start: "Load.Sales",
      direction: "downstream",
      mode: "tree",
      tree: { name: "Load.Sales", children: [] },
    },
    tm1_analyze_chore_graph: {
      choreName: "Daily.Load",
      tasks: [
        {
          step: 0,
          processName: "Load.Sales",
          choreParams: {},
          tree: { name: "Load.Sales", children: [] },
        },
      ],
    },
    tm1_analyze_object_usage: {
      kind: "cube",
      name: "Sales",
      accessMode: "all",
      count: 2,
      returned: 2,
      truncated: false,
      usages: [{ process: "Load.Sales" }, { process: "Clear.Sales" }],
    },
    tm1_search_code: {
      pattern: "CellPutN",
      caseSensitive: false,
      tabsSearched: ["prolog", "data"],
      processesScanned: 50,
      matchCount: 2,
      truncated: false,
      maskSecrets: true,
      excludeCommented: false,
      total: 2,
      count: 2,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        { process: "Load.Sales", tab: "data", line: 12, text: "CellPutN(...)" },
        { process: "Load.Costs", tab: "data", line: 8, text: "CellPutN(...)" },
      ],
    },
    tm1_check_cube_rule: {
      ok: true,
      cube: "Sales",
      lineCount: 5,
      errorCount: 0,
      errors: [],
    },
    tm1_check_process_code: {
      ok: false,
      processName: "_compile_check",
      errorCount: 1,
      errors: [{ procedure: "Prolog", lineNumber: 3, message: "syntax" }],
    },
    tm1_compile_process: {
      ok: true,
      processName: "Load.Sales",
      errorCount: 0,
      errors: [],
    },
    tm1_get_process_parameters: {
      processName: "Load.Sales",
      parameters: [
        { name: "p", type: "String", defaultValue: "x" },
      ],
    },
    tm1_get_process_variables: {
      processName: "Load.Sales",
      variables: [
        { name: "v1", type: "String", position: 1 },
      ],
    },
    tm1_get_client: { Name: "admin", Enabled: true },
    tm1_get_cube_rules: {
      cubeName: "Sales",
      rulesText: "[]=N:1;",
      skipCheck: false,
    },
    tm1_get_cube_stats: {
      count: 1,
      items: [
        {
          cubeName: "Sales",
          populatedNumeric: 12500,
          populatedString: 0,
          fedCells: 18000,
          memoryFeeders: 524288,
          memoryTotal: 8912896,
          feederEfficiency: 1.44,
          raw: {
            "Memory Used for Feeders": 524288,
            "Number of Populated Numeric Cells": 12500,
            "Number of Fed Cells": 18000,
            "Total Memory Used": 8912896,
          },
        },
      ],
    },
    tm1_get_server_info: {
      serverName: "tm1srv",
      productVersion: "11.8",
      extra: {},
    },
    tm1_get_message_log: {
      count: 1,
      entries: [
        { timestamp: "2026-05-02T10:00:00", level: "INFO", message: "ok" },
      ],
    },
    tm1_get_transaction_log: {
      count: 1,
      entries: [
        {
          timestamp: "2026-05-02T10:00:00",
          user: "admin",
          cubeName: "Sales",
          elements: ["EU", "Jan"],
          oldValue: 100,
          newValue: 200,
        },
      ],
    },
    tm1_get_file_content: {
      fileName: "data.csv",
      totalBytes: 1024,
      returnedBytes: 1024,
      truncated: false,
      content: "a,b,c\n1,2,3",
    },
    tm1_list_error_logs: {
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        { filename: "Load.Sales_20260504_123045.log", lastUpdated: "2026-05-04T12:30:45Z" },
      ],
    },
    tm1_get_error_log_content: {
      filename: "Load.Sales_20260504_123045.log",
      totalBytes: 256,
      returnedBytes: 256,
      truncated: false,
      content: "ERROR: Process 'Load.Sales' line 12 — Invalid dimension 'Foo'\n",
    },
    // Generic mutation envelope: success + per-tool extras flow through
    // passthrough. One fixture per shape variant is enough to lock behavior.
    tm1_assign_client_group: { success: true, clientName: "admin", groupName: "ADMIN" },
    tm1_cancel_thread: { success: true, threadId: 42 },
    tm1_clear_cube: { success: true, cubeName: "Sales", summary: "Region=*, Period=Jan" },
    tm1_create_chore: { success: true, name: "Daily.Load", stepCount: 2, active: true },
    tm1_create_client: { success: true, name: "newuser" },
    tm1_create_element: { success: true, elementName: "DE" },
    tm1_create_element_attribute: { success: true, attributeName: "Currency", attributeType: "String" },
    tm1_create_subset: { success: true, subsetName: "EU", kind: "static" },
    tm1_delete_element: { success: true, elementName: "DE" },
    tm1_delete_process: { success: true, processName: "Load.Sales" },
    tm1_delete_subset: { success: true, subsetName: "EU" },
    tm1_move_element: { success: true, elementName: "DE", newParent: "EU" },
    tm1_update_element: { success: true, elementName: "DE" },
    tm1_update_element_attribute_value: {
      success: true,
      dimensionName: "Region",
      elementName: "DE",
      attributeName: "Currency",
      value: "EUR",
    },
    tm1_update_subset: { success: true, subsetName: "EU" },
    tm1_write_cells: { success: true, cellsWritten: 100 },
    tm1_invalidate_callgraph_cache: {
      cleared: 3,
      entriesBefore: [
        { key: "tm1://server/refs", ageMs: 1234, ttlRemainingMs: 60_000, buildMs: 250 },
      ],
    },
  };

  for (const [toolName, payload] of Object.entries(PHASE2_SAMPLES)) {
    it(`${toolName}: structured output validates against schema`, () => {
      const entry = OUTPUT_SCHEMA_MAP[toolName];
      expect(entry, `missing schema for ${toolName}`).toBeDefined();
      const result = asSchema(entry).safeParse(payload);
      if (!result.success) {
        throw new Error(
          `${toolName} validation failed: ${JSON.stringify(result.error.issues, null, 2)}`,
        );
      }
    });
  }
});
