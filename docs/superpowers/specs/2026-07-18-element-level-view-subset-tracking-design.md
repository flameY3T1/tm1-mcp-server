# Element-level tracking through views & subsets — design spec

**Date:** 2026-07-18
**Status:** approved, ready for implementation plan

## Problem

Question a user actually asked: *"Which process processes element `Stoerfall` from cube
`ZusaetzlicheFahrten` onward?"* The central transfer process
(`SBI_IMP_500_250_Transfer_nach_Ausfaelle`) reads that element through a
**view/subset datasource**, not a code-level `CellGet`. The current analysis pipeline
could not surface it from the element angle.

Root cause: the callgraph / ReferenceIndex has **no element granularity** and **never
parses or resolves view/subset membership**. The finest grain for cube access is the
*cube*; for dimension access it is the *dimension* (rule brackets `[dim].[el]` parse the
element string then **discard** it). So "element X is read/written by process P" is a
**blind spot** whenever the element is reached through a view or subset rather than a
literal `CellGetN('Cube', ..., 'X', ...)` argument.

### Verified current-state (code evidence)

- `RefTargetKind = 'cube' | 'dimension' | 'process'` — no `element` kind.
  `src/lib/callgraph/referenceIndex.ts:47`
- Rule-bracket extraction keeps only the dimension, drops the element string.
  `referenceIndex.ts:353-358`
- `TM1CubeView` datasource collapses to a whole-cube synthetic read; the view name
  (`ds.view`) is discarded, no MDX fetched. `src/lib/callgraph/dataFlow.ts:88-107`
  (cube handling ~92-97)
- `TM1DimensionSubset` datasource produces only a cosmetic label `subset:<name>` — not
  even a dimension edge. `dataFlow.ts:104-106`
- View/subset **creation** functions are skip-listed, so their args are never indexed:
  `subsetcreatebymdx`, `viewcreatebymdx`, `viewcreate`, `subsetcreate` in
  `SKIP_VALIDATION_FUNCS` → `continue`. `referenceIndex.ts:35-43`, drop at `:277`
- The index never fetches Views or Subsets server objects at all — only process code,
  cube rules, chores. `src/lib/callgraph/tm1-adapter.ts:72-119`
- `ProcessService.listDataSources` **does** return `view` and `subset` names, but the
  consumer (`dataFlow.ts`) discards them. `src/tm1-client/services/process-service.ts:502-527`

## Goal

Answer "which processes read/write element X (of dimension D)" — including when X is
reached through a view or subset — with an explicit honesty boundary for cases that are
only resolvable at runtime.

Add an `element` grain and close the three distinct paths by which an element enters a
process's data flow. They differ sharply in cost; ship cheapest-first.

## The three buckets

| Bucket | Where the element lives | Fetch needed? | MDX parse? | Cost | Phase |
|---|---|---|---|---|---|
| **A** In-code subset/view construction (`SubsetElementInsert`, `ViewSubsetAssign`, …) | literal string arg in TI code | no | no | **cheap** | 1 (MVP) |
| **B** Server-side view/subset object, element named explicitly | literal in stored MDX / static subset | yes (Views/Subsets) | scoped literal match | medium | 2 |
| **C** Computed membership (`TM1FILTERBYLEVEL`, `DESCENDANTS`, attribute filters) | never literal — derived at runtime | yes | full evaluation | expensive | 3 (defer) |

### Bucket A — in-code subset/view build (the real win)

The element is a **literal string argument in the process code**. Example:

```
csDim = 'Datenquellen';
if(SubsetExists(csDim, csSubset)=1);
   SubsetDestroy(csDim, csSubset);
endif;
SubsetCreate(csDim, csSubset, isTemp);
SubsetElementInsert(csDim, csSubset, 'SuDatenquellen_C', 1);
ViewSubsetAssign(csCube, csView, csDim, csSubset);
```

The process then iterates `csView` as its datasource, so `SuDatenquellen_C` is one of the
rows it processes — yet today nothing captures it, purely because these functions are
skip-listed and there is no element grain. This is **the same class of analysis the
pipeline already does well** (literal/var-resolved function args, cf. `CellGetS`), just
switched off for these functions.

`csDim` (`'Datenquellen'`) is resolvable via the existing flow-sensitive
`buildProcessEnv` / `liveVars`; the element (`'SuDatenquellen_C'`) is a literal.

**Functions to cover (dimension arg + element arg positions):**
- `SubsetElementInsert(dim, subset, element, index)` — element = arg[2], dim = arg[0]
- `SubsetElementDelete(dim, subset, element)` — element = arg[2] (removal; record as a
  subset-membership touch, see open questions)
- `SubsetCreateByMdx` / `SubsetCreate` — establishes a subset handle (name → dim)
- `ViewSubsetAssign(cube, view, dim, subset)` — links subset handle → view + cube
- (`ViewCreate`, etc. — structural, not element-bearing; index only for the view↔cube
  link if the precise variant is built)

**Two precision levels — pick per open question:**
- **Coarse MVP:** every `SubsetElementInsert` element-arg → record an element
  reference `(process, dimension, element, access: write-into-subset/read-context)`.
  Ignore the view-chain. Already answers "which process touches element X."
- **Precise:** chain the string handles within the process —
  `datasource view → ViewSubsetAssign → subset → SubsetElementInsert elements` — so the
  element is attributed specifically to the datasource the process iterates. Needs
  intra-process handle linking of `csView` / `csSubset` variables.

**Decision:** build **precise** directly (handle-chaining in Phase 1, no coarse-first
step). The element is attributed to the specific datasource the process iterates.

### Bucket B — server-side view/subset object, explicit element

Element is named literally inside a **stored** view MDX or a **static** subset (built
outside this process, or persisted). Requires fetching the object definition — the
unavoidable cost here is the **fetch**, not the parse.

**Approach (no MDX AST parser):** scoped literal match. Given target dimension `D` and
element `X`, test the MDX / subset text for `[D].[…X…]` or `.[X]` with bracket / word
boundaries (never a naked substring — `X` may be a substring of another member name).

Fetch surface (new, additive to `tm1-adapter.ts`): pull view definitions and subset
definitions for the objects that actually appear as process datasources (from
`listDataSources`, whose `view`/`subset` names are currently discarded) — bounded, not
"all views on the server."

### Bucket C — computed membership (defer, flag honestly)

Element is **never literal** — membership is derived: `TM1FILTERBYLEVEL(TM1SUBSETALL([D]),0)`
(all leaves, incl. `Stoerfall`, name absent), `DESCENDANTS([D].[Parent])` (pulled via
ancestor), `TM1FILTERBYPATTERN` / attribute filters. A literal match cannot see these.

Only resolvable by **evaluating** the subset/view against a live server → concrete
element list. Expensive and server-round-trip-heavy. **Out of scope for now.** The
pipeline must **flag** its presence rather than silently imply completeness:
"explicit element references found; dynamic selectors (`…`) not resolved."

## Data model

New `RefTargetKind` member: `'element'`. An element reference carries **both** the
dimension and the element (an element name alone is ambiguous across dimensions):

```ts
export interface ElementRef {
  dimension: string;
  element: string;
  via: 'code-subset' | 'code-view' | 'view-mdx' | 'subset-mdx' | 'subset-static';
  // 'code-subset' = Bucket A; 'view-mdx'/'subset-*' = Bucket B
  section?: RefSection;   // for code-origin refs
  line?: number;
  snippet?: string;
}
```

Unresolved element ref (element name not statically resolvable), mirroring
`UnresolvedCall`:

```ts
export interface UnresolvedElementRef {
  dimension?: string;   // dim may still resolve even when element does not
  expr: string;         // raw element-arg text, e.g. "sElem" or "CellGetS(...)"
  reason: 'dynamic' | 'param';
  section?: RefSection;
  line?: number;
  snippet?: string;
}
```

`ReferenceIndex` gains an element bucket, keyed for both lookup directions:
`byElement: Map<string /* lc "dim element" */, ElementRef[]>` and per-process
`elementRefsByProcess`, plus `unresolvedElementRefsByProcess`. Analogous to the existing
`byCube` / `byDim` maps (`referenceIndex.ts:484-505`) and the unresolved-calls maps.

## Components

### 1. Extraction — `src/lib/callgraph/referenceIndex.ts`
- Remove `subsetcreate` / `subsetcreatebymdx` / `viewcreate` / `viewcreatebymdx` from
  `SKIP_VALIDATION_FUNCS` **for element extraction** (keep any validation-skip they need
  — separate concern). Add a `SUBSET_ELEMENT_FUNCS` table with element/dim arg positions
  (`SubsetElementInsert`, `SubsetElementDelete`, …).
- On such a call: resolve dim arg via existing env; element arg literal (or var-resolved);
  emit an `ElementRef{ via:'code-subset' }`. A **non-resolvable element arg** (name from
  `CellGetS`/param/computed) is **surfaced as an unresolved element ref**, not dropped —
  mirroring the callgraph unresolved-calls feature (`expr`, `reason:'dynamic'|'param'`,
  `snippet`). See `UnresolvedElementRef` below.

### 2. Data flow — `src/lib/callgraph/dataFlow.ts`
- **Subset datasource** (`TM1DimensionSubset`, currently `:104-106`): resolve subset →
  dimension edge at minimum (cheap; names already in hand from `listDataSources`).
- **View datasource** (`:92-97`): keep the cube read; additionally, if the view is
  known (Bucket B fetch) or was built in-code (Bucket A chain), attach the element refs
  it scopes.

### 3. Adapter — `src/lib/callgraph/tm1-adapter.ts`
- Phase 2 only: fetch view + subset definitions for datasource-referenced objects; feed
  their MDX/membership text to the scoped literal matcher.

### 4. Tool surface — `src/tools/…`, `src/tools/schemas/…`
- **Query shape (decided):** extend `tm1_trace_data_flow` with an optional
  `element` + `dimension` filter — "which processes touch element X of dimension D."
  No new tool (keeps tool surface / registration / schema count down; consistent with the
  existing cube-flow direction). When the filter is set, results are scoped to element
  refs matching `(D, X)`.
- Element refs (resolved) + unresolved element refs surfaced on upstream/downstream
  results; add a `resolution` note field distinguishing captured (A/B) from
  unresolved-dynamic (C) and from surfaced-but-unresolved in-code refs.
- Extend the strict output schemas in the **same task** as any handler field (schemas
  reject unknown fields — cf. the callgraph-unresolved-calls spec).

## Honesty / error handling

- Every result that involved a view/subset must state its resolution level: element refs
  found via A/B are exact; any **computed** selector encountered (Bucket C markers:
  `TM1FILTERBY*`, `DESCENDANTS`, `TM1SUBSETALL`, attribute filters) is reported as
  "present, not resolved." Never let C's absence read as "no elements."
- Additive: processes with no element refs emit no element field (backward compatible).

## Scope / phasing (decided: A + B in this delivery)

- **Phase 1 (A, precise):** `element` grain + in-code subset/view element extraction with
  **handle chaining** (view↔subset↔elements↔datasource). Pure code analysis, no fetch, no
  MDX parse. Non-resolvable element args surfaced as `UnresolvedElementRef`. Closes the
  `SubsetElementInsert('SuDatenquellen_C')` pattern.
- **Phase 2 (B):** fetch datasource-referenced view/subset defs (bounded via
  `listDataSources`) + scoped literal MDX match. In scope for this delivery.
- **Phase 3 (C):** live subset/view evaluation of computed membership. **Deferred** —
  flagged as unresolved until then, never implied absent.

A and B ship together; the `element` filter on `tm1_trace_data_flow` covers both once
each phase lands. C is a separate future spec.

## Non-goals

- Full MDX AST parser (explicitly avoided — scoped literal match suffices for B).
- Evaluating dynamic membership against a server (that is Phase 3, deferred).
- Element grain for rule calculations beyond what closes the data-flow question (rule
  bracket element strings are currently dropped; capturing them is a possible later win,
  not required here).

## Decisions (resolved 2026-07-18)

1. **A precision:** build **precise** (handle chaining) directly — no coarse-first step.
2. **Query shape:** extend `tm1_trace_data_flow` with an optional `element` + `dimension`
   filter — no dedicated tool.
3. **Var-unresolvable element arg:** **surface** as `UnresolvedElementRef` (mirror
   unresolved-calls), do not silently drop.
4. **Scope:** ship **Phase 1 (A) + Phase 2 (B)** together; Phase 3 (C) deferred to a
   separate spec.

## Still open (settle during plan)

- **`SubsetElementDelete`:** record as a membership touch, or ignore? (It proves the
  process manipulates that element, but the direction is removal — flag as `access`
  variant vs skip.) Lean: record with a distinct access tag.
