# Callgraph unresolved dynamic calls — design spec

**Date:** 2026-07-17
**Status:** approved, ready for implementation plan

## Problem

`tm1_analyze_callgraph` builds a process call graph from `ExecuteProcess`/`RunProcess`
references. The extractor resolves a call's target when it is a string literal or a
single-literal local variable (validated live: `sProc='X'; ExecuteProcess(sProc)` →
edge to `X`). When the target argument is **not** statically resolvable — a
concatenation (`'te'|'st'`), a `CellGetS`/function result, a computed expression, a
multi-assigned variable, or a **process parameter** (`ExecuteProcess(pProc)`, value
only known at runtime) — the reference is **silently dropped** at
`src/lib/callgraph/referenceIndex.ts:265` (`if (binding.kind !== 'literal') { return; }`).

**Consequence — a silent blind spot:**
- Downstream impact analysis ("what does X trigger?") misses dynamic calls. X looks
  harmless while it actually orchestrates other processes → editing/deleting X breaks
  callers' expectations.
- A process that invokes Y only dynamically never appears; Y looks unused → deleting Y
  breaks a real (dynamic) caller.
- "Truly calls nothing" and "has calls we could not resolve" render identically (empty)
  — the analyst cannot tell them apart.

## What this closes (and what it does not)

This turns a **silent omission into a visible marker**. It does **not** resolve the
dynamic targets — that is statically impossible (the value exists only at runtime). It
surfaces each unresolvable call so the analyst knows to check manually.

**In scope:** dynamic/param-target `ExecuteProcess`/`RunProcess` calls, surfaced in
`tm1_analyze_callgraph`.

**Out of scope (unchanged):** unresolved *cube*/*dimension* references (the same
`referenceIndex.ts:265` drop affects them, but `tm1_analyze_object_usage` is
name-keyed and would need a differently-shaped query — deferred). Literal and
literal-variable resolution already works and is not touched.

## Data model

New type (in `referenceIndex.ts`):

```ts
export interface UnresolvedCall {
  section: RefSection;          // prolog | metadata | data | epilog
  line: number;
  funcName: string;             // ExecuteProcess | RunProcess
  expr: string;                 // raw target-arg text, e.g. "sDyn" or "'te'|'st'"
  snippet: string;              // trimmed source line
  reason: 'dynamic' | 'param';  // param = callee is a process parameter; dynamic = everything else
}
```

`ReferenceIndex` gains `unresolvedCallsBySourceProcess: Map<string, UnresolvedCall[]>`
(key = lowercased source process name), populated alongside the existing `byProcess` /
`bySourceProcess` maps.

`CallGraphNode` gains `unresolvedCalls?: UnresolvedCall[]` — the node's own outgoing
calls whose target could not be resolved. Omitted when empty.

## Components

### 1. Extraction — `src/lib/callgraph/referenceIndex.ts`

At the drop point inside `pushRef` (line ~263-266): when the target arg does not
resolve to a literal **and** `kind === 'process'` **and** the function is a process-call
function (`PROCESS_CALL_FUNCS`), record an unresolved call instead of returning:
`reason = binding.kind === 'param' ? 'param' : 'dynamic'`, `expr = argVal.trim()`.
Cube and dimension kinds keep the current `return` (dropped — out of scope).

`extractTiReferences` surfaces these unresolved calls to its caller (via an added
return field or out-parameter — the plan picks the mechanism; it must not change the
resolved-`RawTiRef[]` contract that other callers rely on). `section` is attached by
`pushTi` (mirroring how `TmReference.section` is set), and `buildReferenceIndex`
collects them into `unresolvedCallsBySourceProcess`.

The env used is the existing flow-sensitive `callerEnv`/`liveVars`, so an orchestrator
that reassigns a literal (`sProc='A'; RUNPROCESS(sProc); sProc='B'; RUNPROCESS(sProc)`)
still resolves both as edges — only genuinely non-literal targets become unresolved.

### 2. Graph — `src/lib/callgraph/callGraph.ts`

When building each node (downstream direction only — upstream cannot know who calls a
process dynamically), populate
`node.unresolvedCalls = index.unresolvedCallsBySourceProcess.get(lc(process))` (omit
when empty/absent). Modes:
- `full` and `compact`: include the `unresolvedCalls` array on each node.
- `summary`: the per-process aggregate gains `unresolvedCount: number`.
- global ranking (no `start`): each ranked entry gains `unresolvedCount`; **ranking
  order is unchanged** (still by resolved fan-out/fan-in) — the count is informational.

Upstream direction: `unresolvedCalls` is not emitted (not meaningful).

### 3. Schema + tool — `src/tools/schemas/items.ts`, `src/tools/ti-development/*`

Extend `CallgraphResultSchema` (the union of tree / summary / ranking shapes) so the
node schema allows optional `unresolvedCalls[]` (with the `UnresolvedCall` fields) and
the summary/ranking entries allow optional `unresolvedCount`. Strict schemas reject
unknown fields, so this must land in the **same task** as the handler change that emits
them.

Update the `tm1_analyze_callgraph` tool description: note that
`ExecuteProcess`/`RunProcess` calls whose target is dynamic or a parameter are surfaced
as `unresolvedCalls` (not silently dropped), and that this flags — but does not
resolve — them.

## Error handling

- No new failure modes: unresolved calls are additive metadata. A process with zero
  unresolved calls emits no `unresolvedCalls` field (backward-compatible).
- `param`-callee is classified `reason:'param'` (distinct from `'dynamic'`) so a reader
  can tell "target is a runtime parameter" from "target is a computed expression."

## Testing

**Unit — `referenceIndex`:**
- `sDyn = 'te'|'st'; ExecuteProcess(sDyn)` → one `UnresolvedCall{reason:'dynamic', expr:'sDyn'}`; no resolved process edge for it.
- `ExecuteProcess(pProc)` where `pProc` is a declared parameter → `reason:'param'`.
- `ExecuteProcess('test')` and `sD='test'; ExecuteProcess(sD)` → resolved edges, **no** unresolved entry (no false positives).
- Unresolved cube/dim target (e.g. `CellGetN(sDyn,'x')`) → still dropped, **not** in `unresolvedCallsBySourceProcess` (scope guard).

**Unit — `callGraph`:**
- Node for a process with a dynamic call carries `unresolvedCalls` in `full`/`compact`.
- `summary` mode: `unresolvedCount` present and correct.
- Upstream: no `unresolvedCalls` emitted.

**Live (v12 test server):** recreate a `zVarTest`-style process
(`sDyn='te'|'st'; ExecuteProcess(sDyn)` + a resolved literal call), run
`tm1_analyze_callgraph`, assert the resolved edge appears as a child **and** the dynamic
call appears in `unresolvedCalls`. Delete the fixture after.

**Docs:** README (tool behavior note) + `CHANGELOG.md` `[Unreleased]`.

## Out of scope (future follow-ups)

- Surfacing unresolved cube/dimension references in `tm1_analyze_object_usage`
  (differently-shaped, name-keyed query).
- Chaining/heuristic resolution of dynamic targets (e.g. enumerating possible values) —
  explicitly not attempted.
