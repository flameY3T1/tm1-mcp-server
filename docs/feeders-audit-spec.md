# Spec: `tm1_audit_feeders` (Overfeeding Triage)

**Status:** Draft · **Date:** 2026-05-18 · **Track:** Analysis tools (sibling to `tm1_audit_complexity`)

## Goal

Surface likely **overfeeding** in TM1 cube rules — feeders that flag more cells than the corresponding rules will populate — so the user can triage memory bloat without a live profiler. Pairs static rule-text heuristics with one cheap runtime probe (`}StatsByCube`) so the report distinguishes _hints_ from _evidence_.

References:
- pschwan.de — *Overfeeding in cubes*
- cubewise — *Mastering Conditional Feeders in TM1*
- cubewise — *Troubleshooting Feeders in TM1 with Emojis*
- tm1forum thread 16818

## Non-Goals

- **Full overfeeding proof.** A definitive answer requires cell enumeration / profiler dumps; that lives outside this tool.
- **Auto-rewriting rules.** Tool reports findings; user fixes the rules. No edits.
- **Per-cell breakdown.** We aggregate per cube + per feeder line, not per fed cell.

## What overfeeding looks like (lit review distilled)

1. **Feeder broader than rule** — rule LHS specifies 5 dims, feeder LHS only specifies 2 → feeder fires on all combos of the unspecified 3.
2. **Feeder to a Consolidated (C-level) member** — feeds every descendant N-level cell, even those without a real rule pendant.
3. **Missing `IFEED` / `STET` on conditional rule** — rule uses `IF(value=0, STET, …)` but feeder fires unconditionally → all candidates fed.
4. **Wildcard / unscoped bracket** — `['Dim']` (no element) or `[]` — fires per dimension element.
5. **`DB()` feeder without `skipcheck;` on target** — cross-cube feed cascades through unscoped consolidations.
6. **Alternate-hierarchy double feed** — element belongs to two hierarchies; unqualified feeder feeds via both.
7. **Feeder line whose target dims don't intersect any rule LHS** — orphan feeder, pure overhead.

The negative complement (under-feeding) is also detectable but out of scope for v1 — different fix path, different severity.

## Tool surface (proposed)

```ts
server.tool("tm1_audit_feeders", {
  cubes?: string[]                          // limit to listed cubes; default = all non-control
  mode?: "static" | "runtime" | "both"      // default "static"
  topN?: number                             // cap per finding bucket; default 20
  severityThreshold?: "hint" | "evidence"   // default "hint" (= include all)
  includeControl?: boolean                  // default false (skip `}`-prefix)
})
```

Output schema (sketch):

```jsonc
{
  "status": "pass" | "fail",
  "productVersion": "11.8.x",
  "mode": "static" | "runtime" | "both",
  "scanned": { "cubes": 47, "feederLines": 9182 },
  "findings": [
    {
      "cube": "Sales",
      "line": 142,
      "severity": "hint" | "evidence",
      "rule": "feeder_broader_than_rule" | "feeder_to_consolidated" |
              "missing_ifeed_for_conditional_rule" | "wildcard_bracket" |
              "db_feeder_without_skipcheck" | "orphan_feeder",
      "feeder": "['Year'] => ['Sales']",     // raw line
      "evidence": { /* mode-specific */ }
    }
  ],
  "summary": {
    "byRule": { "feeder_broader_than_rule": 134, ... },
    "byCube": { "Sales": { "hint": 12, "evidence": 1 } },
    "runtimeStats": {            // only present when mode includes "runtime"
      "topByMemory":   [ { "cube": "Sales", "memoryBytes": 1234567 } ],
      "topBySparsity": [ { "cube": "X", "fed": 1e6, "populated": 1.2e4, "sparsity": 0.012 } ]
    }
  },
  "truncated": { "findings": false }
}
```

`status="fail"` mirrors `audit-complexity`: only when at least one finding has `severity:"evidence"` OR (default) when a tunable threshold is exceeded. Default = informational, like `audit-complexity` after HIGH-2 fix.

## Static heuristics (mode: "static")

### S1 · Feeder broader than rule (most common)

Compare each feeder LHS against the set of rule LHS in the same cube.

- A rule LHS is a list of `(dim, elem)` pairs (or positional element list).
- A feeder LHS likewise.
- **Heuristic:** If a feeder's `(dim, elem)` set is a **strict subset** of every rule LHS that "intersects" it, flag as broader-than-rule.
- Edge: feeders intentionally use rollup C-level for one side — needs C-level detection (S2) to not false-positive.

### S2 · Feeder targets Consolidated element

Requires element-type lookup (one REST call per distinct element in feeders). Cache aggressively.

- For each LHS element referenced in any feeder, batch-fetch `Elements?$select=Name,Type&$filter=Name in (…)` per hierarchy.
- If `Type == "Consolidated"`, flag the feeder line. Severity = `hint`.

### S3 · Missing IFEED/STET for conditional rule

- Scan rules section for `IF(…, …, STET, …)` or implicit conditional patterns.
- For each such rule, locate the matching feeder. If feeder LHS isn't wrapped in `IF`/`IFEED`/`STET`, flag.
- AST help: we already detect `isFeedstrings`; we don't yet detect `STET` per-line — add a `hasStet: boolean` line flag in `parseRules`.

### S4 · Wildcard / unscoped bracket

- Detect bracket lists that contain only dim names without element refs.
- Already partly visible via `parseBracketDimRefs` (returns empty `elems[]`).
- **Gap (from probe):** positional syntax `['Elem1','Elem2']` without `Dim:` prefix doesn't go through `parseBracketDimRefs`. New parser needed (see §Prerequisites).

### S5 · DB() feeder without skipcheck on target

- Walk `extractDbCalls` over feeder lines only.
- For each target cube, look up its rules AST; if `ast.hasSkipcheck === false`, flag.

### S6 · Orphan feeder

- Feeder LHS shares no `(dim, elem)` overlap with any rule LHS in the cube.
- Edge: feeders for view-driven reads (no rule) — accept on a denylist?

## Runtime evidence (mode: "runtime" / "both")

One MDX against `}StatsByCube` per scan (not per cube). Returns:

| Measure | Reading |
|---|---|
| `totalMemoryBytes` | RAM footprint per cube → top-N flag |
| `populated cell count` | actual non-empty cells |
| `fed cell count` | cells the feeder graph has marked |
| `sparsity = populated / fed` | <X% → `evidence` for overfeeding |

`}StatsByCube` not always present (depends on perf-monitor setup). Tool must:
- detect cube absence and degrade gracefully (`runtimeStats: null`, message in output)
- never fail the whole scan because runtime mode unavailable

Cube stats existing in this repo: `tm1_get_cube_stats`. Reuse the same service method to avoid duplicating the MDX.

## Prerequisites (must build before tool ships)

1. **Positional bracket-list parser** (`src/lib/feeders/brackets.ts`)
   - Handles `['Elem1','Elem2','Elem3']` (positional) AND `['Dim':'Elem']` (qualified)
   - Mixed-syntax support inside one bracket: `['Year':'2026', 'Sales']`
   - Sets via `{}`: `['Year':{'2025','2026'}]`
   - Returns `Array<{ dim?: string; elem?: string; elems?: string[] }>`
   - Tests: 20+ cases covering both forms + mixed + empty + escaping
2. **Cube dimension-order resolver** — reuse / extend `cubes.getCubeDimensionNames`. Used to map positional elements → dims.
3. **Element-type lookup with cache** (`src/lib/feeders/element-type-cache.ts`)
   - Batch `Elements?$select=Name,Type` per `(dim, hierarchy)`
   - LRU keyed by `(dim, hier, elem) → "Numeric" | "Consolidated" | "String"`
   - One scan = at most N cache misses per (dim, hier) regardless of how many feeders reference elements
4. **`hasStet` + `hasIfeed` line flags in `parseRules`** — minor extension to existing AST (additive, same pattern as `hasFeedstrings` from MED-3 fix).

## Risks / open questions

- **False-positive rate** on real data is unknown — probe ran against a 4-cube test server with mostly positional unqualified feeders, none of which today's parser sees. Build positional parser first, re-probe.
- **Cube-stats availability** — `}StatsByCube` requires perf-monitor; if absent, runtime mode is useless. Need fallback to plain `}Stats` MDX or skip the cube.
- **Severity calibration** — without ground-truth profiling we can only call findings "hints". `evidence` requires a runtime signal (memory > X _and_ sparsity < Y). Define X, Y empirically on first real client model — not in this spec.
- **Cross-cube feeder graphs** — DB() feeders may cascade through 4+ cubes. v1 reports the first hop only; multi-hop chase = v2.

## Phased plan

| Phase | Scope | Exit |
|---|---|---|
| P0 | Positional bracket parser + tests | parser handles ≥95% of feeder lines from probe rerun |
| P1 | Static heuristics S1, S4, S6 (no REST lookups) | tool registers, returns findings on test server |
| P2 | S2 + S5 (requires element-type cache) | C-level + DB-target-skipcheck findings live |
| P3 | S3 (requires `hasStet` AST extension) | conditional-rule findings live |
| P4 | Runtime mode (`}StatsByCube` MDX + sparsity scoring) | runtime-evidence severity escalates findings |
| P5 | False-positive tuning on bigger model + doc update | tool documented, default `severityThreshold` calibrated |

P0 + P1 = MVP shippable on its own.

## Out of scope (later, separate tools)

- Underfeeding detection (rule without feeder).
- Feeder graph visualisation (callgraph-like UI).
- Auto-suggesting `IFEED` / `STET` rewrites.
- Alternate-hierarchy double-feed detection (needs hierarchy-graph build-up — defer).
