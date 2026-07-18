# Bucket C1 — targeted computed-axis resolution — design spec

**Date:** 2026-07-18
**Status:** draft, pending approval
**Extends:** the element-level view/subset tracking line (Bucket A grain, Phase 1.5 usage
classification, Bucket B stored-datasource membership — all merged at `286b6c2`). This is **Bucket C1**,
the narrow, targeted slice of the deferred Bucket C.

## Problem

An element can be scoped by a **computed** MDX selector that never names it —
`TM1FILTERBYLEVEL(TM1SUBSETALL([D]),0)` (all leaves), `DESCENDANTS([D].[P])`, `TM1FILTERBYPATTERN`,
attribute filters. Bucket B's literal member-matcher cannot see the element; it flags the process in
`computedInProcesses` and stops (honest, but unresolved).

**Live finding (2026-07-18) that shrinks the surface:** `SubsetService.get` (`$expand=Elements`)
returns the **server-resolved** element list even for a dynamic/MDX subset. So a stored subset — static
OR dynamic — is already resolved exactly by Bucket B (`subset-static`), never computed. Therefore the
ONLY place a computed selector stays unresolved is **view-level MDX** with no pre-resolved element
list:
- **C1 (this spec):** a **native-view axis** carrying an inline MDX `expression` (an anonymous
  set on one dimension) that uses a computed selector. `ViewService.getDefinition` already returns this
  per-dimension as `ViewAxisSubsetRef.expression` (`src/types.ts:190-194`) — the "part that targets the
  dimension" is ALREADY isolated. No MDX parsing needed.
- **C2 (deferred):** a raw MDX **view** (`ViewDefinition.type='MDX'`, whole `SELECT … FROM [cube]`).
  Isolating the traced dimension's set from an arbitrary SELECT (crossjoins, WHERE, nested) needs a
  real MDX parser. Out of scope; such processes stay in `computedInProcesses`.

## Goal

For C1 only: when a native-view axis `expression` is computed and the traced element was not found
literally, **evaluate just that one dimension-scoped set expression** against the view's cube and check
whether the traced element is a member — turning an unresolved `computedInProcesses` flag into an exact
`source` hit when the element really is in the set. Preserve the tool's **read-only** contract and never
false-claim on failure.

## Approach

Evaluate the isolated axis set expression via a members-only MDX read — **no temporary server object**
(that would be a write, breaking read-only):

```
SELECT { <axis-expression> } ON 0 FROM [ <viewCube> ]
```

Read the axis member names from the response; membership = traced element ∈ members. The cube is the
native view's cube (the datasource `sourceName`). This is `tm1_execute_mdx`-style, side-effect-free (no
data mutation; rule/feeder calc is acceptable).

Why this is cheap and targeted (the user's point): the native axis `expression` is already the set for
exactly one dimension — we evaluate that single set, not the whole view (no full cell materialization,
no other axes).

## Integration

Extends Bucket B's `buildDatasourceMembership` (`src/lib/callgraph/datasourceMembership.ts`), which
already walks native-view axes. Add an injected dep:

```ts
interface MembershipDeps {
  getViewDefinition(cube, view): Promise<ViewDefinition>;
  getSubset(dim, hier, subset): Promise<Subset>;
  evaluateSetExpression?(cube: string, mdxSet: string): Promise<string[]>;   // NEW (C1) — resolved member names; optional
}
```

When a native-view axis has an `expression` (currently: `addMdx` → literal members + computed flag):
- keep the literal `extractMdxMemberRefs` pass (fast, exact for named members);
- **additionally**, IF `evaluateSetExpression` is provided AND the expression had computed selectors,
  call `evaluateSetExpression(cube, expression)` → resolved members → `addMember(process, dim, member,
  'view-native-computed')` for each. `dim` = the axis `dimensionName`.
- On any error/timeout from `evaluateSetExpression`: swallow into `fetchErrors` (already surfaced) and
  leave the computed flag — never drop, never false-claim.

New `MembershipVia = … | 'view-native-computed'` distinguishes a live-resolved-computed hit from a
literal one (lower-confidence provenance the reader can weigh).

The handler (`trace-data-flow.ts`) wires `evaluateSetExpression` to a thin
`tm1Client`-backed call (execute-MDX members-only) ONLY when the new opt-in flag is set.

## Tool surface

- New input `resolveComputed?: boolean` — **default `false`** (decided). Rationale: unlike A/B/1.5
  (pure static analysis) and B's definition-fetches, C1 runs **live set evaluations during analysis**
  (extra round-trips, rule calc). Opt-in keeps the default fast and side-effect-light.
- When `resolveComputed=true`, C1-resolved processes appear in `element.processes` with
  `access:['source']` + `via:['view-native-computed']`; when off (default), those processes remain in
  `computedInProcesses` exactly as today.
- `resolution` string notes whether computed resolution ran.

## Decisions (resolved 2026-07-18)

1. **Scope = C1 only** (native-view axis inline expression). C2 (raw MDX view parse) deferred; stays
   flagged.
2. **Read-only via members-only `execute_mdx`** (`SELECT {expr} ON 0 FROM [cube]`), NO temp subset.
3. **Opt-in:** `resolveComputed` default `false`.
4. **Honest failure:** eval error/timeout → `fetchErrors` + stay flagged, never false-claim.

## Non-goals

- C2 raw MDX view set-extraction (needs an MDX parser).
- Resolving computed selectors on stored subsets — moot (server already resolves them, per the live
  finding).
- Evaluating whole views / materializing cells — we evaluate only the single dimension's set.

## Live verification (2026-07-18, tm1-test — both checks PASS)

**Surface is real.** Created a native view on `Cube_Assumptions` with an anonymous computed row
expression `{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}`. `getViewDefinition` returned that axis as
inline `expression` (NOT materialized to a `subsetName`): `rows:[{dimensionName:"Currency",
hierarchyName:"Currency", expression:"{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}"}]`. So anonymous
computed axis expressions exist and reach us as raw MDX — C1 has a genuine surface (distinct from named
subsets, which Bucket B already resolves exactly).

**Eval mechanism works, read-only.** `SELECT {TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)} ON 0 FROM
[Cube_Assumptions]` via execute-MDX returned `axes[0].tuples[].members[].name` = `["EUR","CHF","USD",
"Group_EUR"]` (each `hierarchyName:"Currency"`); the other cube dims were auto-defaulted into `axes[1]`
(context) and needed no explicit axis. No temp object created. Membership check (USD ∈ set) is a plain
array test.

## Decided from verification

- **Cube:** `ds.sourceName` (the native view's cube). `{expr} ON 0 FROM [cube]` works for a single-dim
  set; ignore `axes[1]` (auto-context).
- **Member listing:** reuse the execute-MDX cellset path — read `axes[0].tuples[].members[].name`,
  **filter by `hierarchyName === dimension`** to guard against unexpected multi-member tuples. Ignore
  cells.

## Open (settle in plan)

- **Cache** resolved set-expression results per (cube, expression) within one trace, so an axis shared
  by multiple processes' views is evaluated once.
- Exact `tm1Client` call for the members-only eval (which service method / does one exist, or add a
  thin `evaluateSetExpression` on a service — this WOULD be new REST, so it goes in a service under
  `src/tm1-client/services/`, unlike Bucket B). Confirm the cellset-read shape the client exposes.
