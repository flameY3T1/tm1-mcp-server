// Metadata-domain item/result schemas: cubes, dimensions, hierarchies,
// elements, attributes, rules, cube stats and hierarchy navigation.
import { z } from "zod";

import { ELEMENT_TYPE } from "./items-common.js";

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
  // Present only when tm1_list_dimensions includeElementCount=true.
  // Map hierarchyName → total.
  elementCounts: z.record(z.string(), z.number().int()).optional(),
  // Present only when tm1_list_dimensions includeElementStats=true.
  // Map hierarchyName → {total, numeric, consolidated, string, maxLevel}.
  elementStats: z.record(z.string(), ElementStatsSchema).optional(),
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
