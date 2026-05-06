// Zod schemas for the per-item types returned by paginated list_* tools.
// Mirrors the TypeScript interfaces in src/types.ts so the runtime
// outputSchema and the static type cannot drift.
//
// Schemas are intentionally permissive (`.passthrough()` where the upstream
// REST surface is loose) — TM1 occasionally returns extra fields and we
// don't want validation to break a useful payload.
import { z } from "zod";

export const ELEMENT_TYPE = z.enum(["Numeric", "String", "Consolidated"]);
export const PARAM_TYPE = z.enum(["String", "Numeric"]);

// Hoisted: shared by transaction-log entries and MDX/cell tools below.
export const CellValueSchema = z.union([z.string(), z.number(), z.null()]);

export const CubeItemSchema = z.object({
  name: z.string(),
  // Omitted when caller sets includeDimensions=false on tm1_list_cubes.
  dimensions: z.array(z.string()).optional(),
  // Present only when caller sets includeRules=true on tm1_list_cubes.
  hasRules: z.boolean().optional(),
});

export const DimensionItemSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
});

export const ProcessParameterSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

export const ProcessVariableSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  position: z.number().int(),
  startByte: z.number().int().optional(),
  endByte: z.number().int().optional(),
});

export const CompileErrorSchema = z.object({
  lineNumber: z.number().int().optional(),
  procedure: z.string().optional(),
  message: z.string(),
});

export const ServerInfoSchema = z
  .object({
    serverName: z.string(),
    productVersion: z.string(),
    productEdition: z.string().optional(),
    adminHost: z.string().optional(),
    dataDirectory: z.string().optional(),
    timeZoneId: z.string().optional(),
    integratedSecurityMode: z.string().optional(),
    extra: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const MessageLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
});

export const TransactionLogEntrySchema = z.object({
  timestamp: z.string(),
  user: z.string(),
  cubeName: z.string(),
  elements: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
  lastUpdated: z.string().optional(),
});

export const ErrorLogContentResultSchema = z.object({
  filename: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
});

export const FileContentResultSchema = z.object({
  fileName: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
});

// ── Phase 2h: uniform mutation envelope ──────────────────────────────────────
// Every create/update/delete/execute tool returns {success: true, ...identifying fields}
// on success. Passthrough so per-tool extras (cellsWritten, parameterCount,
// updatedTabs etc.) flow through without bespoke schemas.
export const MutationResultSchema = z
  .object({
    success: z.boolean(),
  })
  .passthrough();

// Bespoke shapes for mutations whose payload is rich enough to type explicitly.
export const InvalidateCallgraphCacheResultSchema = z.object({
  cleared: z.number().int(),
  entriesBefore: z.array(
    z.object({
      key: z.string(),
      ageMs: z.number(),
      ttlRemainingMs: z.number(),
      buildMs: z.number(),
    }),
  ),
});

export const BulkUpsertElementsResultSchema = z.object({
  success: z.boolean(),
  dimension: z.string(),
  hierarchy: z.string(),
  totalElements: z.number().int(),
  counts: z.object({
    N: z.number().int(),
    C: z.number().int(),
    S: z.number().int(),
  }),
});

export const ProcessItemSchema = z.object({
  name: z.string(),
  // Omitted when caller passes fields=['name'] to tm1_list_processes for compact output.
  parameters: z.array(ProcessParameterSchema).optional(),
});

export const ChoreItemSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  startTime: z.string(),
  frequency: z.string(),
  // In compact mode (tm1_list_chores compact=true) the full processes[] array
  // is replaced by processCount. Both fields are therefore optional at schema
  // level; the tool guarantees exactly one is present.
  processes: z
    .array(
      z.object({
        name: z.string(),
        parameters: z.record(z.string(), z.union([z.string(), z.number()])),
      }),
    )
    .optional(),
  processCount: z.number().int().optional(),
});

export const ClientItemSchema = z
  .object({
    Name: z.string(),
    FriendlyName: z.string().optional(),
    Type: z.string().optional(),
    Enabled: z.boolean().optional(),
    Groups: z.array(z.object({ Name: z.string() })).optional(),
    groupCount: z.number().int().optional(),
  })
  .passthrough();

export const GroupItemSchema = z
  .object({
    Name: z.string(),
    Clients: z.array(z.object({ Name: z.string() })).optional(),
    clientCount: z.number().int().optional(),
  })
  .passthrough();

export const ViewItemSchema = z.object({
  name: z.string(),
  mdx: z.string().optional(),
  private: z.boolean(),
});

export const SubsetItemSchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  hierarchyName: z.string(),
  private: z.boolean(),
  expression: z.string().optional(),
  elements: z.array(z.string()),
  alias: z.string().optional(),
});

export const ThreadItemSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  state: z.string(),
  function: z.string(),
  objectName: z.string(),
  elapsedTime: z.string().optional(),
  objectType: z.string().optional(),
  lockType: z.string().optional(),
  waitTime: z.string().optional(),
  info: z.string().optional(),
  context: z.string().optional(),
});

export const SessionItemSchema = z.object({
  id: z.string(),
  user: z.string(),
  active: z.boolean().optional(),
  threads: z.array(ThreadItemSchema),
});

export const ElementAttributeValueSchema = z.object({
  elementName: z.string(),
  attributeName: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
});

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();

// ── Phase 2 domain schemas ───────────────────────────────────────────────────

export const HierarchyElementSchema = z.object({
  name: z.string(),
  type: ELEMENT_TYPE,
  level: z.number().int(),
  // parents/children omitted when caller passes compact=true to tm1_get_hierarchy.
  parents: z.array(z.string()).optional(),
  children: z.array(z.object({ name: z.string(), weight: z.number() })).optional(),
});

export const HierarchySchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  elements: z.array(HierarchyElementSchema),
});

export const ProcessCodeSchema = z.object({
  prolog: z.string(),
  metadata: z.string(),
  data: z.string(),
  epilog: z.string(),
});

export const DataSourceSchema = z
  .object({
    type: z.enum([
      "None",
      "TM1CubeView",
      "TM1DimensionSubset",
      "ASCII",
      "ODBC",
      "TM1Process",
    ]),
    dataSourceNameForServer: z.string().optional(),
    dataSourceNameForClient: z.string().optional(),
    asciiDelimiterType: z.string().optional(),
    asciiDelimiterChar: z.string().optional(),
    asciiQuoteCharacter: z.string().optional(),
    asciiHeaderRecords: z.number().int().optional(),
    asciiDecimalSeparator: z.string().optional(),
    asciiThousandSeparator: z.string().optional(),
    usesUnicode: z.boolean().optional(),
    userName: z.string().optional(),
    password: z.string().optional(),
    oDBCConnection: z.string().optional(),
    query: z.string().optional(),
    view: z.string().optional(),
    subset: z.string().optional(),
  })
  .passthrough();

export const CubeRulesSchema = z.object({
  cubeName: z.string(),
  skipCheck: z.boolean(),
  // Full mode (default): rulesText carries the verbatim TM1 rule body.
  // Summary mode (tm1_get_all_cube_rules summary=true): rulesText is replaced
  // by aggregate metrics so analysis agents can survey rule landscapes
  // without paying full token cost.
  rulesText: z.string().optional(),
  lineCount: z.number().int().optional(),
  ruleCount: z.number().int().optional(),
  feederCount: z.number().int().optional(),
  commentLineCount: z.number().int().optional(),
  referencedCubes: z.array(z.string()).optional(),
});

export const MdxAxisSchema = z.object({
  tuples: z.array(
    z.object({
      members: z.array(
        z.object({ name: z.string(), hierarchyName: z.string() }),
      ),
    }),
  ),
});

export const ViewResultSchema = z.object({
  cubeName: z.string(),
  viewName: z.string(),
  cells: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
  axes: z.array(MdxAxisSchema),
});

// Composite results emitted by validation/check tools.

export const WritableCoordsResultSchema = z
  .object({
    cube: z.string(),
    writable: z.boolean(),
    allElementsExist: z.boolean(),
    allElementsNLevel: z.boolean(),
    coords: z.array(z.unknown()),
    ruleOverlapWarn: z.unknown().optional(),
  })
  .passthrough();

export const ValidateProcessRefsResultSchema = z.object({
  processName: z.string().nullable(),
  cubeRefsScanned: z.number().int(),
  dimensionRefsScanned: z.number().int(),
  unresolved: z.number().int(),
  issues: z.array(z.unknown()),
});

export const MdxResultSchema = z.object({
  cells: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
  axes: z.array(MdxAxisSchema),
  totalCellCount: z.number().int(),
});

export const ProcessResultSchema = z.object({
  success: z.boolean(),
  processErrorStatus: z.string(),
  errorLogFile: z.string().optional(),
});

// ── Phase 2d: diff/bundle/upsert ─────────────────────────────────────────────

export const DiffProcessResultSchema = z
  .object({
    processName: z.string(),
    identical: z.boolean(),
    tabs: z.unknown(),
    parameters: z.unknown(),
    variables: z.unknown(),
    dataSource: z.unknown(),
  })
  .passthrough();

export const UpsertProcessResultSchema = z
  .object({
    processName: z.string(),
    action: z.enum(["created", "updated"]),
    appliedSteps: z.array(z.string()),
  })
  .passthrough();

const InstallBundleEntrySchema = z
  .object({
    file: z.string().optional(),
    processName: z.string().nullable().optional(),
    status: z.string(),
  })
  .passthrough();

export const InstallProBundleResultSchema = z
  .object({
    directory: z.string(),
    filesFound: z.number().int(),
    dryRun: z.boolean().optional(),
    mode: z.string().optional(),
    counts: z
      .object({
        created: z.number().int(),
        updated: z.number().int(),
        preflight_failed: z.number().int(),
        error: z.number().int(),
        skipped: z.number().int(),
      })
      .optional(),
    results: z.array(InstallBundleEntrySchema),
  })
  .passthrough();

export const ImportProFileResultSchema = z.object({
  action: z.string(),
  processName: z.string(),
  parsed: z.object({
    prologLines: z.number().int(),
    metadataLines: z.number().int(),
    dataLines: z.number().int(),
    epilogLines: z.number().int(),
    parameterCount: z.number().int(),
    variableCount: z.number().int(),
    dataSourceType: z.string(),
  }),
});

export const CopyProcessResultSchema = z.object({
  success: z.boolean(),
  sourceName: z.string(),
  targetName: z.string(),
});

// ── Phase 2e: analysis tools ─────────────────────────────────────────────────

// analyze_callgraph emits one of:
//   - warning shape {warning, indexedProcessCount}
//   - tree shape    {start, direction, mode, tree}
//   - summary shape {start, direction, mode, summary}
// Modeled as one passthrough schema with all fields optional except none.
export const CallgraphResultSchema = z
  .object({
    warning: z.string().optional(),
    indexedProcessCount: z.number().int().optional(),
    start: z.string().optional(),
    direction: z.string().optional(),
    mode: z.string().optional(),
    summary: z.unknown().optional(),
    tree: z.unknown().optional(),
  })
  .passthrough();

export const ChoreGraphResultSchema = z.object({
  choreName: z.string(),
  tasks: z.array(
    z
      .object({
        step: z.number().int(),
        processName: z.string(),
        choreParams: z.unknown(),
        tree: z.unknown(),
      })
      .passthrough(),
  ),
});

export const ObjectUsageResultSchema = z.object({
  kind: z.string(),
  name: z.string(),
  count: z.number().int(),
  usages: z.array(z.unknown()),
});

// ── tm1_get_cube_stats result schemas ────────────────────────────────────────
// Stats elements differ between TM1 v11 and v12. We expose well-known names
// as typed fields (best-effort match) and the entire raw element-name → value
// map under `raw` so callers can read whatever the server actually returned
// — no version drift breaks the tool, only renames new well-known fields.
export const CubeStatsItemSchema = z
  .object({
    cubeName: z.string(),
    // Cell counts
    populatedNumeric: z.number().optional(),
    populatedString: z.number().optional(),
    storedCalculated: z.number().optional(),
    storedViews: z.number().optional(),
    fedCells: z.number().optional(),
    // Memory (bytes)
    memoryViews: z.number().optional(),
    memoryInput: z.number().optional(),
    memoryFeeders: z.number().optional(),
    memoryCalculations: z.number().optional(),
    memoryTotal: z.number().optional(),
    // Performance
    avgCalculationSteps: z.number().optional(),
    cacheMissRate: z.number().optional(),
    // Derived
    feederEfficiency: z.number().optional(),
    // Always present: full element-name → value map (carries everything,
    // including v12-only or new-build metrics that aren't in KNOWN_METRICS).
    raw: z.record(z.string(), z.union([z.number(), z.null()])),
    error: z.string().optional(),
  })
  .passthrough();

export const CubeStatsResultSchema = z
  .object({
    count: z.number().int(),
    items: z.array(CubeStatsItemSchema),
  })
  .passthrough();

export const SearchCodeResultSchema = z.object({
  pattern: z.string(),
  caseSensitive: z.boolean(),
  tabsSearched: z.array(z.string()),
  processesScanned: z.number().int(),
  matchCount: z.number().int(),
  truncated: z.boolean(),
  matches: z.array(
    z.object({
      process: z.string(),
      tab: z.string(),
      line: z.number().int(),
      text: z.string(),
    }),
  ),
});
