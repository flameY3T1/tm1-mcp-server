# Element usage classification (source vs zero-out vs indeterminate) — design spec

**Date:** 2026-07-18
**Status:** approved, ready for implementation plan
**Extends:** `2026-07-18-element-level-view-subset-tracking-design.md` (Phase 1 / Bucket A, shipped).
This is **Phase 1.5** — a correctness refinement of the Bucket A element attribution.

## Problem

Bucket A (shipped, `1573f45`) attributes an element to a process whenever the process calls
`SubsetElementInsert`/`SubsetElementAdd`/`SubsetElementDelete` with that element. That answers
"the process **puts element X into some subset**" — but **not** the question the user actually asks:
"which process **processes element X onward** (reads it and flows it downstream)?"

The same `SubsetElementInsert('Currency','sTmp','USD',1)` can serve completely different roles:

- **Read source** — the subset feeds a view used as the process's datasource → the process genuinely
  reads USD's cells and flows them onward.
- **Zero-out / clear target** — the subset feeds a view passed to `ViewZeroOut(cube, view)` (or a
  clear) → the process **zeroes** USD's region; it does not "process it onward."
- **Something else we cannot see statically** — the subset is built and may still be used (iterated
  by an index loop, assigned to a view consumed by a *different* process, referenced through a
  dynamic name, passed as a parameter). We must **not** claim it is unused.

Live-confirmed today: the tool reports `funcNames:["SubsetElementInsert"]` with no usage signal, so a
zero-out process and a genuine read-source process are indistinguishable. This over-reports and, for
the motivating question, is semantically wrong.

## Goal

Tag each Bucket-A element attribution with an **access classification** derived from how the subset
(and any view it is assigned to) is used *within the same process*, and let the tool filter to the
role the user means. The classification is **honest**: it never asserts "unused" — the absence of a
detected use becomes `indeterminate`, not a negative claim.

## Access taxonomy

`access` (on each element→process attribution):

| value | meaning | detected by (in-process) |
|---|---|---|
| `source` | subset/view feeds a READ the process consumes | subset→`ViewSubsetAssign`→view is the process datasource; OR `TM1DimensionSubset` datasource on that subset; OR subset-index loop containing a `CellGet*` |
| `zero-out` | subset/view feeds a zero/clear of that region | subset→view passed to `ViewZeroOut`/view-clear |
| `write` | subset/view feeds a non-zero WRITE | subset-index loop containing a `CellPut*` (non-zero); other view write |
| `indeterminate` | subset built (and maybe assigned), no in-process source/write/zero use found — **may still be processed** cross-process, by an index loop we could not classify, or via a dynamic name | default when nothing above matches; **never reported as "unused"** |

Notes:
- A single element→process pair may carry **multiple** access tags (a process can source AND
  zero-out the same element). `access` is therefore a set/array, not a scalar.
- `indeterminate` is the honest floor. The design spec's Bucket-C principle applies: absence of a
  detected use is flagged, never asserted as no-use.

## The chain to resolve (in-process, var-aware)

Element usage is a handle-chain, all within one process, resolved with the existing flow-sensitive
`resolveExpression`/`liveVars`:

```
SubsetElementInsert(dim, sub, elem)        -- elem enters subset `sub` (of dim)
ViewSubsetAssign(cube, view, dim, sub)     -- links view `view` (of cube) to subset `sub`
  then, on `view`:
    process datasource == view             -> source
    ViewZeroOut(cube, view)                -> zero-out
    (view write op)                        -> write
-- OR, without a view, an index loop over `sub`:
    SubsetGetSize(dim, sub) / SubsetGetElementName(dim, sub, i) present
      + CellGet* in same process           -> source
      + CellPut* in same process           -> write / zero-out (0 literal → zero-out)
-- OR TM1DimensionSubset datasource == sub -> source
-- else                                    -> indeterminate
```

Handles (`sub`, `view`) are frequently variables (`csSubset`, `csView`). Resolve them with the
existing env; when a handle does not resolve to a literal, the chain link is broken → fall to
`indeterminate` (do not guess). This is the "precise handle-chaining" deferred in Phase 1, now
justified by the zero-out case.

**Degradation is honest, not silent:** a process that inserts an element into a subset whose name is
dynamic, or whose view is consumed elsewhere, lands in `indeterminate` with a reason — the user sees
"this process touches X but we could not classify how," never a false `source` and never a dropped row.

## Data model (extends Phase 1)

`byElement` element refs already carry `dimension` + `element` + `funcName`. Add usage context so the
tool can classify. Two viable shapes (plan picks one):

- **A (ref-level):** extend the element `TmReference` with an optional `subsetHandle?: string`
  (resolved or raw) so a post-pass can join it to `ViewSubsetAssign`/`ViewZeroOut`/datasource facts.
- **B (process-level index):** a new per-process structure
  `subsetUsageByProcess: Map<process, Array<{ subset; view?; cube?; access: AccessKind[]; resolved: boolean }>>`
  built once from the process's TI, then joined to element refs at query time.

Recommended: **B** — the classification is a whole-process property (needs `ViewSubsetAssign`,
`ViewZeroOut`, datasource, loop scan together), cleaner than smearing it across per-call refs.

`AccessKind = 'source' | 'zero-out' | 'write' | 'indeterminate'`.

## Tool surface

`tm1_trace_data_flow` element result:
- `element.processes[]` gains `access: AccessKind[]` (augments the current `funcNames`; keep
  `funcNames` too if cheap — it is still informative).
- New optional input `elementAccess?: AccessKind[]` (**default `['source','write','zero-out']`**) —
  filters `element.processes` to the roles the user means. The default shows all concretely-classified
  uses; `indeterminate` is opt-in (`elementAccess` including `'indeterminate'`, or a superset). Even
  under the default, a summary count of suppressed `indeterminate` processes is reported so nothing is
  silently hidden.
- The `resolution` marker string is extended to state the classification basis and that
  `indeterminate` ≠ "not used."

## Scope / non-goals

- **In scope:** in-process, var-aware classification of subset/view usage into the four `AccessKind`s;
  the `elementAccess` filter; honest `indeterminate`.
- **Non-goals:** cross-process view-consumer resolution (a view built in process P, used as datasource
  in process Q) — that is a graph-join across processes; for now such a P lands in `indeterminate`
  (Q is still caught by Bucket B's datasource path independently). Full MDX/dynamic-name resolution
  stays out (that is Bucket C).
- **Interaction with Bucket B:** Bucket B (stored view/subset datasources) is inherently `source`
  (a datasource is read). When both land, merge access tags per process.

## Decisions (resolved 2026-07-18)

1. **Default filter:** `elementAccess` defaults to `['source','write','zero-out']` — all concrete
   classifications shown; `indeterminate` is opt-in, and a suppressed-`indeterminate` count is always
   surfaced.
2. **`zero-out` separate:** its own `AccessKind`, not a `write`+flag. `zero-out` fires on `ViewZeroOut`
   / a `CellPut*` with a literal `0`; other writes are `write`.
3. **Index-loop detection IN scope:** a `SubsetGetSize`/`SubsetGetElementName` loop over the subset,
   classified by the cell op inside — `CellGet*` → `source`, `CellPut*` → `write` (literal `0` →
   `zero-out`).
4. **Model B** (process-level `subsetUsageByProcess` index), joined to element refs at query time.

## Still open (settle during plan)

- Loop-body↔subset association precision: how tightly must the `CellGet*`/`CellPut*` be tied to the
  specific subset loop (same loop block) vs merely co-present in the process? Tighter = fewer false
  `source`/`write`; looser = simpler. Plan picks; when uncertain, prefer flagging `indeterminate` over
  a confident wrong tag.
