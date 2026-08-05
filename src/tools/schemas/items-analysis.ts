// Analysis-domain schemas: callgraph, chore-graph, object-usage, data-flow,
// feeder/calc tracing, code/rule search, audits, v12-readiness and the
// callgraph-cache invalidation result.
import { z } from "zod";

import { CellValueSchema } from "./items-common.js";

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

// Wire-size note (this is by far the largest published outputSchema): the SDK
// serializes outputSchemas with Zod 4's `toJSONSchema` (draft-7), which INLINES
// a reused sub-schema at every use site — except when the sub-schema carries a
// registry id via `.meta({ id })`, in which case it is emitted once under
// `definitions` and referenced by `$ref`. `$ref`/`definitions` already ship in
// this schema regardless (the recursive `children` cycle is emitted as
// `#/definitions/__schema0`), so named ids add no new client requirement.
// Ids only pay off for sub-schemas used MORE THAN ONCE — a single-use id makes
// the payload bigger (def + ref > inline). Validation is untouched: `.meta()`
// only annotates, it never changes parsing.

// Zod 4 emits `z.number().int()` as {type:integer, minimum:-2^53+1, maximum:2^53-1}.
// Those sentinel bounds no longer reach the wire — `slimJsonSchema()` strips them
// at tools/list time — so an inlined int costs 18 bytes, LESS than the 28-byte
// `$ref` a shared id would cost. Hence no id here (measured on the shipped,
// slimmed payload: id-off 4770 vs id-on 5043 bytes). Re-add the id only if that
// slimmer is ever removed. The EffectiveValue id below pays off either way.
const IntSchema = z.number().int();

// EffectiveValue: {kind:'literal';value}|{kind:'unknown';viaParam}|{kind:'dynamic'}
// Used twice (edge.effectiveParams[].effective and node.env values) → id it.
const EffectiveValueSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("literal"), value: z.string() }),
    z.object({ kind: z.literal("unknown"), viaParam: z.string() }),
    z.object({ kind: z.literal("dynamic") }),
  ])
  .meta({ id: "EffectiveValue" });

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
  line: IntSchema,
  funcName: z.string(),
  snippet: z.string(),
  params: z.array(CallParamSchema),
  effectiveParams: z.array(EffectiveParamSchema).optional(),
});

// unresolvedCalls entry — full mode carries `snippet`, compact mode does not.
// Kept as two shapes on purpose: merging them behind one `snippet?` schema
// would save ~180 bytes but stop the guard noticing if full mode ever dropped
// `snippet`, which is exactly the drift this schema exists to catch.
const UnresolvedFullSchema = z.object({
  section: z.string(),
  line: IntSchema,
  funcName: z.string(),
  expr: z.string(),
  snippet: z.string(),
  reason: z.string(),
});
const UnresolvedCompactSchema = z.object({
  section: z.string(),
  line: IntSchema,
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
// `.strict()` is load-bearing, not cosmetic: `tree` below is a union of this and
// CompactNodeSchema, and a non-strict Zod object STRIPS unknown keys instead of
// rejecting them. Without it a full-mode node carrying a corrupt `incomingEdge`
// or `env` simply matched the compact variant with those keys thrown away, so
// the drift guard this schema exists for never fired. Safe because serializeNode
// / serializeCompact build fixed object literals (analyze-callgraph.ts) and
// undefined-valued keys are dropped before structuredContent is parsed.
const FullNodeSchema: z.ZodType<FullNode> = FullNodeBase.extend({
  children: z.lazy(() => z.array(FullNodeSchema)),
}).strict();

// Compact-mode node (serializeCompact). Recursive via z.lazy on `children`.
const CompactNodeBase = z.object({
  process: z.string(),
  cycle: z.boolean().optional(),
  depthLimitReached: z.boolean().optional(),
  unresolvedCalls: z.array(UnresolvedCompactSchema).optional(),
});
type CompactNode = z.infer<typeof CompactNodeBase> & {
  children: CompactNode[];
};
// Strict for the same reason as FullNodeSchema above — this is the variant that
// used to swallow every stray key in the union.
const CompactNodeSchema: z.ZodType<CompactNode> = CompactNodeBase.extend({
  children: z.lazy(() => z.array(CompactNodeSchema)),
}).strict();

// summarize() result.
const SummaryEntrySchema = z.object({
  process: z.string(),
  depthMin: IntSchema,
  depthMax: IntSchema,
  occurrences: IntSchema,
  cycle: z.boolean(),
  depthLimitReached: z.boolean(),
  unresolvedCount: IntSchema,
});
const CallgraphSummarySchema = z.object({
  root: z.string(),
  totalNodes: IntSchema,
  uniqueProcesses: IntSchema,
  maxDepth: IntSchema,
  cyclesDetected: IntSchema,
  depthLimitsHit: IntSchema,
  processes: z.array(SummaryEntrySchema),
});

// globalRanking() RankEntry.
const RankEntrySchema = z.object({
  process: z.string(),
  outgoingCalls: IntSchema,
  outgoingDistinct: IntSchema,
  incomingCalls: IntSchema,
  incomingDistinct: IntSchema,
});

// One permissive top-level object whose optional fields are now precisely
// typed — every real payload validates, and the typed fields are enforced.
// `tree` accepts both full and compact nodes (full is tried first; a compact
// node fails FullNode because `cycle`/`incomingEdge` are required there).
// No `.passthrough()` — that is what made the guard structurally blind.
export const CallgraphResultSchema = z.object({
  // shape 1: warning (process not found)
  warning: z.string().optional(),
  indexedProcessCount: IntSchema.optional(),
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
  totalProcessesIndexed: IntSchema.optional(),
  processesWithEdges: IntSchema.optional(),
  totalCallEdges: IntSchema.optional(),
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
          access: z.array(
            z.enum(["source", "write", "zero-out", "indeterminate"]),
          ),
          via: z.array(z.string()).optional(),
        }),
      ),
      unresolvedInProcesses: z.array(z.string()).optional(),
      suppressedIndeterminate: z.number().int().optional(),
      computedInProcesses: z.array(z.string()).optional(),
      resolution: z.string(),
    })
    .optional(),
  // True when `limit` clipped the upstream/downstream arrays. `counts` keeps
  // the unclipped totals, so the caller can always see how much was left out.
  truncated: z.boolean().optional(),
  hint: z.string().optional(),
});

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
      z
        .object({ cube: z.string(), line: z.number().int(), text: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();

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
    topFunctions: z.array(
      z.object({ function: z.string(), count: z.number().int() }),
    ),
  }),
  findings: z.array(V12FindingSchema),
  rulesetSource: z.string(),
});
