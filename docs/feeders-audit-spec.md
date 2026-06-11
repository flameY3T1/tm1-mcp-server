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
3. **Unconditional feeder for conditional rule** — rule uses `IF(value=0, STET, …)` but feeder fires unconditionally → all candidates fed. (TM1 has no `IFEED` keyword; the fix is wrapping the feeder LHS in plain `IF(…)`.)
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
      "topByFedRatio": [ { "cube": "X", "fed": 1e6, "populated": 1.2e4, "fedToPopulatedRatio": 83.3 } ]
    }
  },
  "truncated": { "findings": false }
}
```

`status="fail"` mirrors `audit-complexity`: only when at least one finding has `severity:"evidence"` OR (default) when a tunable threshold is exceeded. Default = informational, like `audit-complexity` after HIGH-2 fix.

## Static heuristics (mode: "static")

### S1 · Feeder broader than rule (most common)

Each bracket entry — positional, qualified, or set-form — pins exactly one
dimension. S1 pairs each feeder with the rule it most likely feeds and
flags only when the feeder is structurally broader than that rule.

**Pairing**: `feeder.RHS` (the bracket on the right of `=>`) is matched
against every rule LHS by element-bag overlap; the rule with the highest
overlap wins. Feeder source elements (LHS) and rule target elements (LHS)
are usually different in idiomatic TM1 (`['M:Src'] => ['M:Tgt']` feeding
`['M:Tgt'] = N: ['M:Src'] - …`), so the RHS overlap is the structural link.

**Flag**: `feeder.LHS.entries.length < matchedRule.LHS.entries.length`.
Equal pinning is the idiomatic 1:1 N: pattern and is **not** flagged.

**Fallback**: when no rule shares any element with the feeder.RHS — and
the feeder isn't a cross-cube `=> DB(...)` (whose rule lives in the
target cube, covered by S5) — drop back to the ratio gate
`feeder.entries.length / cubeTotalDims < s1MinPinnedRatio` (default `0.5`)
so cubes with non-trivial rule sets but unusual feeder shapes still get
some signal.

Iteration history:

| 2026-05-18 (P1, entry-count vs densest rule)       | 91 % false positives  |
| 2026-05-19 (P2 a, absolute threshold = 2 unpinned) | 98 % false positives  |
| 2026-05-19 (P2 b, ratio < 0.5)                     | accepted              |
| 2026-05-19 (P6, rule-pairing on feeder.RHS)        | ~92 % FP eliminated   |

The ratio gate alone scaled across cube widths but still over-flagged
idiomatic 1:1 patterns where the feeder is correctly dimensioned for
its rule. Rule-pairing is the structurally correct signal; the ratio
remains as a fallback for unmatched feeders.

### S2 · Feeder targets Consolidated element

Requires element-type lookup (one REST call per distinct element in feeders). Cache aggressively.

- For each LHS element referenced in any feeder, batch-fetch `Elements?$select=Name,Type&$filter=Name in (…)` per hierarchy.
- If `Type == "Consolidated"`, flag the feeder line. Severity = `hint`.

### S3 · Conditional rule without conditional feeder

Terminology note (corrected 2026-05-18): TM1 has **STET** (rules-side keyword
meaning "leave this cell untouched") and plain **`IF()`** (works in both rules
and feeders). There is no `IFEED` keyword — earlier drafts of this spec called
it that erroneously.

- Scan rules section: a line is *conditional* if it contains `STET` or wraps
  its RHS in `IF(…)`.
- For each such rule, locate the matching feeder. If the feeder LHS isn't
  itself guarded by an `IF(…)` (Cubewise-style conditional feeder), flag it
  — unconditional feeder + conditional rule = feed-everything overshoot.
- AST help: we already detect `isSkipcheck`/`isFeedstrings`; we don't yet
  detect `STET` or LHS-`IF` per line — add `hasStet: boolean` and
  `hasIfGuard: boolean` line flags in `parseRules`.

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

Shipped 2026-05-19. One `}StatsByCube` MDX per scanned cube, run in parallel
via `Promise.allSettled`. Reuses the fetcher at `src/lib/cube-stats/fetcher.ts`
shared with `tm1_get_cube_stats`.

| Measure                     | Reading                                                            | Default gate                           |
|-----------------------------|--------------------------------------------------------------------|----------------------------------------|
| `memoryTotal` / `memoryMb`  | RAM footprint per cube                                             | `cube_high_memory` when ≥ 1024 MB      |
| `populatedNumeric`          | stored input cells                                                 | denominator of fed ratio               |
| `fedCells`                  | cells the feeder graph has marked                                  | numerator of fed ratio                 |
| `fedToPopulatedRatio = fed / populated` | community-standard overfeeding indicator               | `cube_high_fed_ratio`: hint when ≥ 50 (`fedRatioThreshold`), evidence when ≥ 100 (`fedRatioEvidenceThreshold`) |
| `feederMemoryRatio = memoryFeeders / memoryInput` | secondary signal, context only                | never flagged (no established threshold) |

Threshold calibration follows TM1-community consensus (tm1forum t=13110:
lotsaram names fed/populated and feeder-memory/input-memory as the two
meaningful `}StatsByCube` overfeeding ratios, investigation-worthy from
~100×; Cubewise: 50× suspicious, 100× definite; some practitioners use
20×). The ratio compares two *different* populations — `populatedNumeric`
counts stored input cells, `fedCells` counts feeder flags — so values
below the threshold (including < 1 on dense input cubes) are normal
feeder fan-out, and a zero denominator (cube fed purely cross-cube, input
lives elsewhere) yields `null` = insufficient signal, never a flag. The
ratio is a presumptive indicator, not proof — hence hint/evidence
tiering, with the Cubewise shadow-cube/helper-measure technique as the
definitive (dev-only, out-of-scope) confirmation method.

Findings: `cube_high_fed_ratio` at ≥ `fedRatioEvidenceThreshold` and
`cube_high_memory` carry severity `evidence`. Every existing static
finding on the same cube is then escalated from `hint` to `evidence` in
the response.

`}StatsByCube` is not always present (depends on perf-monitor setup). The
tool degrades per-cube: a failed fetch records `available: false` and an
`error` string under `runtimeStats[cubeName]`; the scan continues. Static
findings on the same cube remain at severity `hint`.

Live test 2026-05-19 (7 cubes, mode `both`): 7/7 stats fetched, 1 cube
flagged on both runtime gates (fed/populated ≈ 213× — reported as
`cube_low_sparsity` 0.47 % under the pre-2026-06-11 metric — plus
`cube_high_memory` 1.3 GiB) — the production cube `Cube_FP_alt`
we already suspected from the S1/S2 static findings.

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
4. **`hasStet` + `hasIfGuard` line flags in `parseRules`** — minor extension to existing AST (additive, same pattern as `hasFeedstrings` from MED-3 fix). `hasIfGuard` = the line begins with `IF(` regardless of section.

## Risks / open questions

- **False-positive rate** on real data is unknown — probe ran against a 4-cube test server with mostly positional unqualified feeders, none of which today's parser sees. Build positional parser first, re-probe.
- **Cube-stats availability** — `}StatsByCube` requires perf-monitor; if absent, runtime mode is useless. Need fallback to plain `}Stats` MDX or skip the cube.
- **Severity calibration** — without ground-truth profiling we can only call findings "hints". `evidence` requires a runtime signal (memory > X _and_ sparsity < Y). Define X, Y empirically on first real client model — not in this spec.
- **Cross-cube feeder graphs** — DB() feeders may cascade through 4+ cubes. v1 reports the first hop only; multi-hop chase = v2.

## Phased plan

| Phase | Scope | Exit |
|---|---|---|
| P0 | Positional bracket parser + tests | parser handles ≥95 % of feeder lines from probe rerun ✓ (95.08 %) |
| P1 | Static heuristics S4 + S6 (no REST lookups) | tool registers, returns findings on test server ✓ |
| P2 | S1 (cube dim-order) + S2 (element-type cache) + S5 (cross-cube skipcheck) ✓ | C-level + DB-target-skipcheck + properly-gated breadth findings live |
| P3 | S3 (`hasStet` + `hasIfGuard` AST extension) ✓ | conditional-rule findings live |
| P4 | Runtime mode (`}StatsByCube` MDX + sparsity scoring) ✓ | runtime-evidence severity escalates findings |
| P5 | `severityThreshold` param + operator docs ✓ (calibration deferred — needs bigger model) | tool documented, CI gate available; threshold tuning awaits a larger production cube |

P0 + P1 = MVP shippable on its own. S1 moved from P1 to P2 after live-test
on 2026-05-18 showed the entry-count proxy was unreliable; resolving cube
dim count is a prerequisite (one REST call per cube — cheap). P2 shipped
2026-05-19 with the dim-order resolver, `ElementTypeCache`, and a
cross-cube skipcheck lookup pre-built from every cube's rules AST.

## Out of scope (later, separate tools)

- Underfeeding detection (rule without feeder).
- Feeder graph visualisation (callgraph-like UI).
- Auto-suggesting `IF(…)` / `STET` rewrites.
- Alternate-hierarchy double-feed detection (needs hierarchy-graph build-up — defer).
