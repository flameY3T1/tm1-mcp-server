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

export const ElementStatsSchema = z.object({
  total: z.number().int(),
  numeric: z.number().int(),
  consolidated: z.number().int(),
  string: z.number().int(),
  maxLevel: z.number().int(),
});

export const DimensionItemSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
  // Present only when tm1_list_dimensions is called with includeElementCount=true.
  // Map hierarchyName → element total.
  elementCounts: z.record(z.string(), z.number().int()).optional(),
  // Present only when tm1_list_dimensions is called with includeElementStats=true.
  // Map hierarchyName → {total, numeric, consolidated, string, maxLevel}.
  elementStats: z.record(z.string(), ElementStatsSchema).optional(),
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
    modelling: z.unknown().optional(),
    ti: z.unknown().optional(),
    rules: z.unknown().optional(),
    mtq: z.unknown().optional(),
    jobQueuing: z.unknown().optional(),
    memory: z.unknown().optional(),
    logging: z.unknown().optional(),
    http: z.unknown().optional(),
    security: z.unknown().optional(),
    _raw: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const MessageLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  errorFile: z.string().optional(),
});

export const TransactionLogEntrySchema = z.object({
  timestamp: z.string(),
  user: z.string(),
  cubeName: z.string(),
  elements: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});

const AuditLogDetailSchema = z.object({
  id: z.number().int(),
  timestamp: z.string(),
  user: z.string(),
  description: z.string(),
  objectType: z.string(),
  objectName: z.string(),
});

export const AuditLogEntrySchema = AuditLogDetailSchema.extend({
  details: z.array(AuditLogDetailSchema).optional(),
});

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
  lastUpdated: z.string().optional(),
});

// groupBy='process' audit-summary item: per-process failure aggregation.
export const ErrorLogGroupSchema = z.object({
  process: z.string(),
  count: z.number().int(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  spanDays: z.number().int(),
  perDay: z.number(),
});

const RelatedErrorLogFileSchema = z.object({
  filename: z.string(),
  deltaSec: z.number().int(),
  totalBytes: z.number().int().optional(),
  returnedBytes: z.number().int().optional(),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
});

export const ErrorLogContentResultSchema = z.object({
  filename: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
  related: z
    .object({
      windowSec: z.number().int().optional(),
      found: z.number().int().optional(),
      maxFiles: z.number().int().optional(),
      note: z.string().optional(),
      files: z.array(RelatedErrorLogFileSchema),
    })
    .optional(),
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

export const JobItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  state: z.string(),
  elapsedTime: z.string().optional(),
  waitTime: z.string().optional(),
  session: z
    .object({
      id: z.string(),
      context: z.string().optional(),
      user: z.string().optional(),
    })
    .optional(),
  waitingOn: z
    .array(z.object({ id: z.string(), description: z.string(), state: z.string() }))
    .optional(),
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

// Attribute *definition* (as returned by listAttributes) — distinct from a
// per-element attribute *value* above. Used by tm1_list_element_attributes.
export const ElementAttributeDefinitionSchema = z.object({
  name: z.string().describe("Attribute name"),
  type: z.enum(["Numeric", "String", "Alias"]).describe("Attribute storage type"),
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
  // true when the topN cap clipped the (post-filter) element set — raise topN.
  truncated: z.boolean(),
});

export const ProcessCodeSchema = z.object({
  prolog: z.string(),
  metadata: z.string(),
  data: z.string(),
  epilog: z.string(),
  hint: z.string().optional(),
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

// tm1_get_process — every section is gated by an include-flag, so all fields
// except `name` are optional. The code tabs sit at the TOP level (the handler
// spreads them into the payload), not under a `tabs` object.
export const GetProcessResultSchema = z.object({
  name: z.string(),
  prolog: z.string().optional(),
  metadata: z.string().optional(),
  data: z.string().optional(),
  epilog: z.string().optional(),
  parameters: z.array(ProcessParameterSchema).optional(),
  variables: z.array(ProcessVariableSchema).optional(),
  dataSource: DataSourceSchema.optional(),
  hasSecurityAccess: z.boolean().optional(),
  hint: z.string().optional(),
});

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

export const ProcessCodeBundleSchema = z.object({
  name: z.string(),
  hasSecurityAccess: z.boolean(),
  // Full mode (default): the four TI tab bodies verbatim (credentials masked
  // by default via maskSecrets).
  prolog: z.string().optional(),
  metadata: z.string().optional(),
  data: z.string().optional(),
  epilog: z.string().optional(),
  // Summary mode (tm1_get_all_processes_code summary=true): tab bodies are
  // replaced by aggregate line metrics so analysis agents can survey the
  // process landscape without paying full token cost.
  totalLines: z.number().int().optional(),
  prologLines: z.number().int().optional(),
  metadataLines: z.number().int().optional(),
  dataLines: z.number().int().optional(),
  epilogLines: z.number().int().optional(),
  commentLines: z.number().int().optional(),
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

// tm1_get_view returns the same page-envelope shape as tm1_execute_mdx
// (axes + paginated cell `items`), plus the cube/view it executed. Cells
// paginate server-side so wide/tall views can't dump their whole cellset.
export const ViewResultSchema = z.object({
  cubeName: z.string(),
  viewName: z.string(),
  axes: z.array(MdxAxisSchema),
  total: z.number().int().nullable(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  items: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
});

export const SampleCellsResultSchema = z.object({
  cubeName: z.string(),
  count: z.number().int(),
  truncated: z.boolean(),
  cells: z.array(
    z.object({
      coordinates: z.record(z.string(), z.string()),
      value: CellValueSchema,
      formattedValue: z.string(),
    }),
  ),
  filtersApplied: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  axisDimension: z.string(),
  rowDims: z.array(z.string()),
  whereDims: z.array(z.string()),
  mdxUsed: z.string(),
  elapsedMs: z.number().int(),
  hint: z.string().optional(),
});

const ViewAxisSubsetRefSchema = z.object({
  dimensionName: z.string().optional(),
  hierarchyName: z.string().optional(),
  subsetName: z.string().optional(),
  expression: z.string().optional(),
});

const ViewTitleRefSchema = ViewAxisSubsetRefSchema.extend({
  selectedElement: z.string().optional(),
});

export const ViewDefinitionResultSchema = z.object({
  cubeName: z.string(),
  viewName: z.string(),
  private: z.boolean(),
  type: z.enum(["MDX", "Native"]),
  mdx: z.string().optional(),
  native: z
    .object({
      titles: z.array(ViewTitleRefSchema),
      columns: z.array(ViewAxisSubsetRefSchema),
      rows: z.array(ViewAxisSubsetRefSchema),
    })
    .optional(),
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

// Page-envelope shape consistent with list_* tools (Page<T>).
// `total` derives from axes (product of tuple counts) — null only when
// axes are absent and we cannot infer cell count cheaply.
export const MdxResultSchema = z.object({
  axes: z.array(MdxAxisSchema),
  total: z.number().int().nullable(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  items: z.array(
    z.object({ value: CellValueSchema, formattedValue: z.string() }),
  ),
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

// Dedicated schema for tm1_import_process_from_git. Currently identical in
// shape to ImportProFileResultSchema, but kept separate so the two import
// paths can diverge (e.g. a .pro-specific field) without one silently
// rejecting the other's payload. Mirror any git-import handler change here.
export const ImportProcessFromGitResultSchema = z.object({
  action: z.string(),
  processName: z.string(),
  hasSecurityAccess: z.boolean().optional(),
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
//   - global rank   {mode:'globalRanking', rankBy, ranking[], ...}  (start omitted)
// Modeled as one passthrough schema with all fields optional except none.
// ── Feeder / calculation tracing (v11 cell diagnostics) ─────────────────────

export const FedCellDescriptorSchema = z.object({
  cube: z.string(),
  tuple: z.array(z.string()),
  fed: z.boolean(),
});

export const CheckFeedersResultSchema = z.object({
  count: z.number().int(),
  unfedCount: z.number().int(),
  fedCells: z.array(FedCellDescriptorSchema),
});

export const TraceFeedersResultSchema = z.object({
  count: z.number().int(),
  fedCells: z.array(FedCellDescriptorSchema),
  statements: z.array(z.string()),
});

// Recursive component tree — children typed as unknown to avoid recursive
// JSON-schema emission (kept permissive; unlike CallgraphResultSchema this
// one is not yet fully typed).
export const CalculationTraceResultSchema = z
  .object({
    type: z.string().optional(),
    status: z.string().optional(),
    value: CellValueSchema,
    cube: z.string().optional(),
    tuple: z.array(z.string()).optional(),
    statements: z.array(z.string()).optional(),
    components: z.array(z.unknown()).optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

// ─── Callgraph output schema (typed, recursive) ──────────────────────────────
// Faithfully mirrors what src/tools/analysis/analyze-callgraph.ts emits so the
// output-schema drift-guard (with-annotations.ts) actually validates the tree
// instead of being blind (`z.unknown()` + `.passthrough()`). One response is
// exactly one of 5 shapes: warning | full tree | compact tree | summary |
// globalRanking. Fields the serializers emit as `undefined` are dropped by the
// JSON round-trip the guard performs, so they are modelled `.optional()`.

// EffectiveValue: {kind:'literal';value}|{kind:'unknown';viaParam}|{kind:'dynamic'}
const EffectiveValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("unknown"), viaParam: z.string() }),
  z.object({ kind: z.literal("dynamic") }),
]);

// CallParamResolution: {kind:'literal';value}|{kind:'passthrough';paramName}|{kind:'dynamic'}
const CallParamResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("passthrough"), paramName: z.string() }),
  z.object({ kind: z.literal("dynamic") }),
]);

// CallParam = {name, resolution, valueRaw}
const CallParamSchema = z.object({
  name: z.string(),
  resolution: CallParamResolutionSchema,
  valueRaw: z.string(),
});

// effectiveParams entry = {name, effective, valueRaw}
const EffectiveParamSchema = z.object({
  name: z.string(),
  effective: EffectiveValueSchema,
  valueRaw: z.string(),
});

// incomingEdge object (serializeNode) — null on the root node.
const CallgraphEdgeSchema = z.object({
  caller: z.string(),
  callee: z.string(),
  section: z.string(),
  line: z.number().int(),
  funcName: z.string(),
  snippet: z.string(),
  params: z.array(CallParamSchema),
  effectiveParams: z.array(EffectiveParamSchema).optional(),
});

// unresolvedCalls entry — full mode carries `snippet`, compact mode does not.
const UnresolvedFullSchema = z.object({
  section: z.string(),
  line: z.number().int(),
  funcName: z.string(),
  expr: z.string(),
  snippet: z.string(),
  reason: z.string(),
});
const UnresolvedCompactSchema = z.object({
  section: z.string(),
  line: z.number().int(),
  funcName: z.string(),
  expr: z.string(),
  reason: z.string(),
});

// Full-mode node (serializeNode). Recursive via z.lazy on `children`.
const FullNodeBase = z.object({
  process: z.string(),
  cycle: z.boolean(),
  depthLimitReached: z.boolean().optional(),
  incomingEdge: CallgraphEdgeSchema.nullable(),
  env: z.record(z.string(), EffectiveValueSchema).optional(),
  unresolvedCalls: z.array(UnresolvedFullSchema).optional(),
});
type FullNode = z.infer<typeof FullNodeBase> & { children: FullNode[] };
const FullNodeSchema: z.ZodType<FullNode> = FullNodeBase.extend({
  children: z.lazy(() => z.array(FullNodeSchema)),
});

// Compact-mode node (serializeCompact). Recursive via z.lazy on `children`.
const CompactNodeBase = z.object({
  process: z.string(),
  cycle: z.boolean().optional(),
  depthLimitReached: z.boolean().optional(),
  unresolvedCalls: z.array(UnresolvedCompactSchema).optional(),
});
type CompactNode = z.infer<typeof CompactNodeBase> & { children: CompactNode[] };
const CompactNodeSchema: z.ZodType<CompactNode> = CompactNodeBase.extend({
  children: z.lazy(() => z.array(CompactNodeSchema)),
});

// summarize() result.
const SummaryEntrySchema = z.object({
  process: z.string(),
  depthMin: z.number().int(),
  depthMax: z.number().int(),
  occurrences: z.number().int(),
  cycle: z.boolean(),
  depthLimitReached: z.boolean(),
  unresolvedCount: z.number().int(),
});
const CallgraphSummarySchema = z.object({
  root: z.string(),
  totalNodes: z.number().int(),
  uniqueProcesses: z.number().int(),
  maxDepth: z.number().int(),
  cyclesDetected: z.number().int(),
  depthLimitsHit: z.number().int(),
  processes: z.array(SummaryEntrySchema),
});

// globalRanking() RankEntry.
const RankEntrySchema = z.object({
  process: z.string(),
  outgoingCalls: z.number().int(),
  outgoingDistinct: z.number().int(),
  incomingCalls: z.number().int(),
  incomingDistinct: z.number().int(),
});

// One permissive top-level object whose optional fields are now precisely
// typed — every real payload validates, and the typed fields are enforced.
// `tree` accepts both full and compact nodes (full is tried first; a compact
// node fails FullNode because `cycle`/`incomingEdge` are required there).
// No `.passthrough()` — that is what made the guard structurally blind.
export const CallgraphResultSchema = z.object({
  // shape 1: warning (process not found)
  warning: z.string().optional(),
  indexedProcessCount: z.number().int().optional(),
  // shared across the traversal shapes
  start: z.string().optional(),
  direction: z.string().optional(),
  mode: z.string().optional(),
  maskSecrets: z.boolean().optional(),
  // shape 4: summary
  summary: CallgraphSummarySchema.optional(),
  // shapes 2 & 3: full / compact tree
  tree: z.union([FullNodeSchema, CompactNodeSchema]).optional(),
  // shape 5: global-ranking (start omitted)
  rankBy: z.string().optional(),
  totalProcessesIndexed: z.number().int().optional(),
  processesWithEdges: z.number().int().optional(),
  totalCallEdges: z.number().int().optional(),
  truncated: z.boolean().optional(),
  ranking: z.array(RankEntrySchema).optional(),
});

export const ChoreGraphResultSchema = z.object({
  choreName: z.string(),
  maskSecrets: z.boolean().optional(),
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
  // Not-found branch: tasks is empty and these two explain why.
  warning: z.string().optional(),
  indexedChoreCount: z.number().int().optional(),
});

// `usages` is present in full mode; `sources`/`sourceCount`/`mode` are present
// in mode='summary'. Both shapes validate against this one schema.
export const ObjectUsageResultSchema = z.object({
  kind: z.string(),
  name: z.string(),
  accessMode: z.string(),
  count: z.number().int(),
  returned: z.number().int(),
  truncated: z.boolean(),
  usages: z.array(z.unknown()).optional(),
  mode: z.string().optional(),
  sourceCount: z.number().int().optional(),
  sources: z.array(z.unknown()).optional(),
});

// ── tm1_trace_data_flow result schema ────────────────────────────────────────
export const DataFlowResultSchema = z.object({
  cube: z.string(),
  direction: z.enum(["upstream", "downstream", "both"]),
  upstream: z
    .array(
      z.object({
        process: z.string(),
        sourceCubes: z.array(z.string()),
        datasourceType: z.string(),
        externalSource: z.string().optional(),
        elements: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  downstream: z
    .array(
      z.object({
        process: z.string(),
        targetCubes: z.array(z.string()),
        readsVia: z.enum(["code", "datasource", "both"]),
        elements: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  counts: z.object({
    upstream: z.number().int().optional(),
    downstream: z.number().int().optional(),
  }),
  element: z
    .object({
      dimension: z.string(),
      name: z.string(),
      processes: z.array(
        z.object({
          process: z.string(),
          funcNames: z.array(z.string()),
          access: z.array(z.enum(["source", "write", "zero-out", "indeterminate"])),
          via: z.array(z.string()).optional(),
        }),
      ),
      unresolvedInProcesses: z.array(z.string()).optional(),
      suppressedIndeterminate: z.number().int().optional(),
      computedInProcesses: z.array(z.string()).optional(),
      resolution: z.string(),
    })
    .optional(),
  hint: z.string().optional(),
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

export const SearchCodeMatchSchema = z.object({
  process: z.string(),
  tab: z.string(),
  line: z.number().int(),
  text: z.string(),
  // Present only when deduplicateByLine=true and ≥1 other process shared this
  // (tab, line-text): the first-seen process is kept, the rest land here.
  alsoFoundIn: z.array(z.string()).optional(),
});

// groupBy mode item: one row per process/tab with its match count.
export const SearchCodeGroupSchema = z.object({
  process: z.string().optional(),
  tab: z.string().optional(),
  matchCount: z.number().int(),
});

// Wrapper around the paginated `items` array — keeps summary fields the agent
// uses to interpret the search (pattern echo, totals, truncation flag).
// Fields that only apply in the default (non-grouped) mode are optional so the
// groupBy='process'|'tab' aggregation shape validates against the same schema.
export const SearchCodeResultSchema = z.object({
  pattern: z.string(),
  caseSensitive: z.boolean(),
  tabsSearched: z.array(z.string()),
  processesScanned: z.number().int(),
  matchCount: z.number().int(),
  truncated: z.boolean().optional(),
  maskSecrets: z.boolean().optional(),
  excludeCommented: z.boolean().optional(),
  // Present only in groupBy mode.
  groupBy: z.enum(["process", "tab"]).optional(),
  groupCount: z.number().int().optional(),
  total: z.number().int(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  items: z.array(z.union([SearchCodeMatchSchema, SearchCodeGroupSchema])),
  // Present only when deduplicateByLine=true: rawMatchCount is the pre-collapse
  // total, deduplicated flags that the collapse ran.
  rawMatchCount: z.number().int().optional(),
  deduplicated: z.boolean().optional(),
});

// ── Audit / analysis + diff tool results ─────────────────────────────────────
// Passthrough: these payloads are deep and evolve (nested summary objects,
// conditional findings vs findingsByGroup). We pin the stable discriminator
// fields and let the rest through so structuredContent is emitted without the
// strict additionalProperties:false footgun rejecting valid responses.

export const AuditComplexityResultSchema = z
  .object({
    status: z.string(),
    productVersion: z.string().optional(),
    scope: z.unknown().optional(),
    scanned: z.unknown().optional(),
    summary: z.unknown().optional(),
  })
  .passthrough();

export const AuditFeedersResultSchema = z
  .object({
    status: z.string(),
    productVersion: z.string().optional(),
    mode: z.string().optional(),
    scanned: z.unknown().optional(),
  })
  .passthrough();

export const AuditNamingResultSchema = z
  .object({
    status: z.string(),
    productVersion: z.string().optional(),
    scope: z.unknown().optional(),
    scanned: z.unknown().optional(),
    summary: z.unknown().optional(),
  })
  .passthrough();

export const DiffProcessesResultSchema = z
  .object({
    processA: z.string(),
    processB: z.string(),
    identical: z.boolean(),
    tabs: z.unknown(),
    parameters: z.unknown(),
    variables: z.unknown(),
    dataSource: z.unknown(),
  })
  .passthrough();

export const SearchRulesResultSchema = z
  .object({
    pattern: z.string(),
    caseSensitive: z.boolean(),
    cubesScanned: z.number().int(),
    matchCount: z.number().int(),
    truncated: z.boolean(),
    includeFeeders: z.boolean(),
    total: z.number().int(),
    count: z.number().int(),
    offset: z.number().int(),
    has_more: z.boolean(),
    next_offset: z.number().int().nullable(),
    items: z.array(
      z.object({ cube: z.string(), line: z.number().int(), text: z.string() }).passthrough(),
    ),
  })
  .passthrough();

// ── Phase 2i: hierarchy navigation, server snapshots, diagnostics ────────────

export const AncestorsResultSchema = z.object({
  element: z.string(),
  ancestors: z.array(
    z.object({ name: z.string(), level: z.number().int() }),
  ),
  paths: z.array(z.array(z.string())),
});

export const DescendantsResultSchema = z.object({
  element: z.string(),
  descendants: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      level: z.number().int(),
      depth: z.number().int(),
    }),
  ),
  // true when the topN cap clipped the descendant set — raise topN.
  truncated: z.boolean(),
});

export const DefaultMemberResolutionSchema = z.object({
  dimension: z.string(),
  hierarchy: z.string(),
  resolved: z.object({ name: z.string(), level: z.number().int() }),
  source: z.enum(["defined", "single_root", "first_root", "index_1"]),
  confidence: z.enum(["high", "medium", "low"]),
  alternatives: z
    .object({
      roots: z.array(z.object({ name: z.string(), level: z.number().int() })),
      indexOne: z.string().optional(),
    })
    .optional(),
  warning: z.string().optional(),
});

export const DefaultMemberErrorSchema = z.object({
  dimension: z.string(),
  hierarchy: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});

export const DefaultMembersBulkResultSchema = z.object({
  results: z.array(
    z.union([DefaultMemberResolutionSchema, DefaultMemberErrorSchema]),
  ),
});

// Server state snapshot curates a few config flags whose surface differs
// per TM1 build — every section is permissive (.passthrough()).
export const ServerStateResultSchema = z
  .object({
    connected: z.boolean(),
    server: z.unknown(),
    capabilities: z.unknown(),
    counts: z.unknown(),
  })
  .passthrough();

export const ProcessesGroupedResultSchema = z.object({
  totalProcesses: z.number().int(),
  groupCount: z.number().int(),
  prefixSegments: z.number().int(),
  groups: z.array(
    z.object({
      prefix: z.string(),
      count: z.number().int(),
      processes: z.array(z.string()).optional(),
    }),
  ),
});

export const DiagnoseProcessErrorResultSchema = z.object({
  processName: z.string(),
  since: z.string().nullable(),
  logsFound: z.number().int(),
  logsReturned: z.number().int(),
  logs: z.array(z.unknown()),
});

export const OrphanDimensionSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
});

export const FindOrphanDimensionsResultSchema = z.object({
  totalDimensions: z.number().int(),
  totalCubes: z.number().int(),
  orphanCount: z.number().int(),
  includeControl: z.boolean(),
  total: z.number().int(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().nullable(),
  items: z.array(OrphanDimensionSchema),
});

export const V12FindingSchema = z.object({
  severity: z.enum(["error", "warning"]),
  category: z.enum(["deprecated_ti_function"]),
  objectKind: z.enum(["process", "cube"]),
  objectName: z.string(),
  section: z.enum(["prolog", "metadata", "data", "epilog", "rules"]),
  line: z.number().int(),
  function: z.string(),
  snippet: z.string(),
  issue: z.string(),
  suggestion: z.string(),
});

export const V12ReadinessResultSchema = z.object({
  scope: z.enum(["processes", "rules", "all"]),
  includeControl: z.boolean(),
  scannedProcesses: z.number().int(),
  scannedCubes: z.number().int(),
  findingsCount: z.number().int(),
  readinessScore: z.enum(["ready", "needs-work", "blocked"]),
  summary: z.object({
    byCategory: z.record(z.string(), z.number().int()),
    bySeverity: z.record(z.string(), z.number().int()),
    topFunctions: z.array(z.object({ function: z.string(), count: z.number().int() })),
  }),
  findings: z.array(V12FindingSchema),
  rulesetSource: z.string(),
});

export const ExportProcessToProResultSchema = z.object({
  processName: z.string(),
  byteLength: z.number().int(),
  writtenTo: z.string().nullable(),
  parameterCount: z.number().int(),
  variableCount: z.number().int(),
  dataSourceType: z.string(),
  content: z.string(),
});

export const ExportProcessToGitResultSchema = z.object({
  processName: z.string(),
  jsonFileName: z.string(),
  tiFileName: z.string(),
  parameterCount: z.number().int(),
  variableCount: z.number().int(),
  dataSourceType: z.string(),
  credentialsOmitted: z.boolean(),
  hasSecurityAccess: z.boolean(),
  writtenTo: z.object({
    json: z.string().nullable(),
    ti: z.string().nullable(),
  }),
  // Full file bodies are echoed inline only when writeToDir is NOT set; when
  // exporting to disk the caller already has the files, so we omit them to
  // avoid flooding the context window with duplicate code.
  json: z.string().optional(),
  ti: z.string().optional(),
});
