import { describe, expect, it } from "vitest";
import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";
import {
  ObjectUsageResultSchema,
  SearchCodeResultSchema,
} from "../../src/tools/schemas/items.js";

// Regression guard for the "data must NOT have additional properties" bug class
// on STRICT (non-passthrough) result schemas.
//
// search_code, get_all_cube_rules and analyze_object_usage publish strict
// z.object outputSchemas. Their handlers emit fields that were missing from the
// declared schema (conditional or wrapper fields), so the SDK rejected every
// call with "structured content does not match the tool's output schema:
// data must NOT have additional properties". The fix is schema COMPLETENESS,
// not passthrough — these tools should still reject genuinely unknown keys.
//
// Each case below is a verbatim handler payload captured live (TM1 11.8). The
// schema must .parse() it without error.

function asSchema(entry: ZodRawShape | ZodTypeAny): ZodTypeAny {
  return typeof entry === "object" && entry !== null && "_def" in entry
    ? (entry as ZodTypeAny)
    : z.object(entry as ZodRawShape);
}

describe("strict outputSchemas accept real handler payloads", () => {
  it("tm1_search_code: deduplicateByLine payload (rawMatchCount, deduplicated, items[].alsoFoundIn)", () => {
    const payload = {
      pattern: "vValue",
      caseSensitive: false,
      tabsSearched: ["prolog", "metadata", "data", "epilog"],
      processesScanned: 90,
      matchCount: 5,
      rawMatchCount: 7,
      deduplicated: true,
      truncated: false,
      maskSecrets: true,
      excludeCommented: false,
      total: 5,
      count: 5,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        {
          process: "Load.Assumptions",
          tab: "data",
          line: 6,
          text: "CellPutN(vValue, 'Cube_Assumptions', ...);",
          alsoFoundIn: ["Load.Assumptions_copy2"],
        },
        {
          process: "Load.Capacity.Plan",
          tab: "data",
          line: 7,
          text: "CellPutN(vValue, 'Cube_Capacity', ...);",
        },
      ],
    };
    expect(() => SearchCodeResultSchema.parse(payload)).not.toThrow();
  });

  it("tm1_analyze_object_usage: write-mode payload (accessMode, returned, truncated)", () => {
    const payload = {
      kind: "cube",
      name: "Cube_Resource",
      accessMode: "write",
      count: 1,
      returned: 1,
      truncated: false,
      usages: [
        {
          sourceKind: "process",
          sourceName: "Load.Resource.Plan",
          section: "data",
          line: 12,
          funcName: "CellPutN",
          snippet: "CellPutN(vValue, 'Cube_Resource', ...);",
          accessType: "write",
        },
      ],
    };
    expect(() => ObjectUsageResultSchema.parse(payload)).not.toThrow();
  });

  it("tm1_search_code: groupBy='process' payload (group items, no truncated/maskSecrets)", () => {
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_search_code);
    const payload = {
      pattern: "ExecuteProcess",
      caseSensitive: false,
      tabsSearched: ["prolog", "metadata", "data", "epilog"],
      processesScanned: 90,
      groupBy: "process",
      groupCount: 3,
      matchCount: 412,
      total: 3,
      count: 3,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        { process: "Master.Run", matchCount: 210 },
        { process: "Load.All", matchCount: 150 },
        { process: "Nightly.Batch", matchCount: 52 },
      ],
    };
    expect(() => schema.parse(payload)).not.toThrow();
  });

  it("tm1_analyze_object_usage: mode='summary' payload (sources, sourceCount, no usages)", () => {
    const payload = {
      kind: "cube",
      name: "Cube_Resource",
      accessMode: "all",
      mode: "summary",
      count: 1191,
      sourceCount: 20,
      returned: 20,
      truncated: false,
      sources: [
        {
          sourceKind: "process",
          sourceName: "Load.Resource.Plan",
          accessTypes: ["read", "write"],
          sections: ["data", "epilog"],
          funcNames: ["CellGetN", "CellPutN"],
          count: 340,
        },
      ],
    };
    expect(() => ObjectUsageResultSchema.parse(payload)).not.toThrow();
  });

  it("tm1_list_error_logs: groupBy='process' payload (group items + wrapper fields)", () => {
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_list_error_logs);
    const payload = {
      groupBy: "process",
      totalFiles: 500,
      groupCount: 3,
      total: 3,
      count: 3,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [
        {
          process: "Nightly.Load",
          count: 120,
          firstSeen: "2026-06-01T02:00:00",
          lastSeen: "2026-06-15T02:00:00",
          spanDays: 15,
          perDay: 8,
        },
        {
          process: "(unparsed)",
          count: 4,
          firstSeen: null,
          lastSeen: null,
          spanDays: 1,
          perDay: 4,
        },
      ],
    };
    expect(() => schema.parse(payload)).not.toThrow();
  });

  it("tm1_import_process_from_git: success payload (action, processName, parsed counts)", () => {
    // Guards the dedicated ImportProcessFromGitResultSchema mapping — this used
    // to point at ImportProFileResultSchema and pass only by coincidence.
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_import_process_from_git);
    const payload = {
      action: "created",
      processName: "Load.Assumptions",
      hasSecurityAccess: false,
      parsed: {
        prologLines: 12,
        metadataLines: 1,
        dataLines: 40,
        epilogLines: 3,
        parameterCount: 2,
        variableCount: 5,
        dataSourceType: "ODBC",
      },
    };
    expect(() => schema.parse(payload)).not.toThrow();
  });

  it("tm1_get_all_cube_rules: summary payload (count, returned, truncated, summary metrics)", () => {
    const schema = asSchema(OUTPUT_SCHEMA_MAP.tm1_get_all_cube_rules);
    const payload = {
      count: 7,
      returned: 7,
      truncated: false,
      cubes: [
        {
          cubeName: "Cube_Compliance",
          skipCheck: true,
          lineCount: 19,
          ruleCount: 3,
          feederCount: 2,
          commentLineCount: 2,
          referencedCubes: ["Cube_Assumptions"],
        },
      ],
    };
    expect(() => schema.parse(payload)).not.toThrow();
  });
});
