# Element-Level View/Subset Tracking — Implementation Plan (Phase 1, Bucket A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the callgraph an `element` grain and extract element references from in-code
subset-membership calls (`SubsetElementInsert`/`SubsetElementAdd`/`SubsetElementDelete`), so
`tm1_trace_data_flow` can answer "which processes touch element X of dimension D" — including
elements a process only reaches by building a subset/view in TI code.

**Architecture:** Pure-code analysis, no new REST. The reference extractor already scans these
functions (they carry a `DimensionName` arg, so they emit a dimension ref today). We add an
element ref alongside — resolving the element-name arg (literal or var-resolved) plus its
dimension — and a reverse `byElement` index. Non-resolvable element args are **surfaced** as
`UnresolvedElementRef` (mirroring the existing `UnresolvedCall` feature), never dropped. The
tool gains an optional `element`+`dimension` filter that queries `byElement`, and each
data-flow row gains the in-code elements that process manipulates.

**Tech Stack:** TypeScript (strict), vitest. Pure functions in `src/lib/callgraph/`; MCP tool
handler in `src/tools/analysis/`; Zod output schema in `src/tools/schemas/items.ts`.

## Global Constraints

- New TM1 REST calls go in a service under `src/tm1-client/services/` — **N/A here** (pure
  analysis code, no new REST; Bucket B, which does add REST, is a separate plan).
- Every tool declares annotation hints in `src/tools/annotation-map.ts` — **N/A** (no new
  tool; `tm1_trace_data_flow` is already annotated read-only).
- **Strict output schemas:** `DataFlowResultSchema` in `src/tools/schemas/items.ts` is a strict
  `z.object` (`additionalProperties:false`). Every new handler field MUST land in the schema in
  the **same task** or the SDK rejects the payload.
- **Secrets:** element/dimension names are object identifiers, not secrets. No new masking
  surface. Do not add snippet fields to the tool output (element identity is enough).
- **Commits:** Conventional Commits; one logical change per commit. No real customer/server
  names in tests or docs — synthetic names only.
- After any tool signature/description change: `npm run tools:update-readme`.

## Verified current-state facts (do not re-derive)

- `RefTargetKind = 'cube' | 'dimension' | 'process'` — `src/lib/callgraph/referenceIndex.ts:47`.
- `TmReference` has `targetKind`/`targetName`, no dimension side-channel — `referenceIndex.ts:70-81`.
- `ReferenceIndex` maps: `byCube`, `byDim`, `byProcess`, `bySourceProcess`,
  `unresolvedCallsBySourceProcess`, … — `referenceIndex.ts:100-115`.
- Auto-derived arg-index maps: `CUBE_ARG_IDX`/`DIM_ARG_IDX`/`PROCESS_ARG_IDX =
  buildArgIdxMap('cubename'|'dimensionname'|'processname')` — `referenceIndex.ts:24-26`.
  `buildArgIdxMap(paramName)` returns `Map<funcLower, argIndex>` by matching the signature param
  name — `referenceIndex.ts:11-22`.
- `extractTiReferences(text, env?, sharedLiveVars?, unresolvedOut?)` — the per-line scanner;
  `pushRef(kind, argIdx)` resolves an arg (literal via `extractStringLiteral`, else
  `resolveExpression(argVal, callerEnv)`), and already surfaces non-literal **process** targets
  into `unresolvedOut` — `referenceIndex.ts:217-313` (push logic `280-309`).
- Signature arg orders (element-bearing subset funcs), from `tiSignatures.ts`:
  - `SubsetElementInsert(DimensionName[0], SubsetName[1], ElementName[2], Position[3])` — `:4387`.
  - `SubsetElementAdd(SubsetName[0], DimensionName[1], ElementName[2])` — `:1506`.
  - `SubsetElementDelete(SubsetName[0], DimensionName[1], ElementName[2])` — `:2721`.
  Arg positions **vary per function** — `buildArgIdxMap('elementname')` /
  `buildArgIdxMap('dimensionname')` already return the correct per-function index, so no manual
  positions are needed.
- These three funcs already carry `DimensionName`, so they are in `TRACKED_FUNCS` and matched by
  `FUNC_RE` today (emitting a dimension ref). They are **not** in `SKIP_VALIDATION_FUNCS`
  (`referenceIndex.ts:35-43`, which lists only the *create* funcs). No skip-list edit needed.
- `traceDataFlow(index, dsList, cubeName, direction)` builds `ProcessIO` per process from
  `index.all` + datasource list — `src/lib/callgraph/dataFlow.ts` (buildProcessIO `65-107`,
  traceDataFlow `~137-180`). `DownstreamReader`/`UpstreamWriter` shapes at `23-39`.
- Tool handler: `src/tools/analysis/trace-data-flow.ts` (inputs `cubeName`/`direction`/
  `includeControl`; calls `buildIndexFromTM1` + `listDataSources` + `traceDataFlow`).
- Output schema: `DataFlowResultSchema` — `src/tools/schemas/items.ts:850-878`.

---

### Task 1: `element` grain — types + reverse index

**Files:**
- Modify: `src/lib/callgraph/referenceIndex.ts` (types `47`, `70-81`, `100-115`; index build/bucketing)
- Test: `tests/unit/callgraph-element-refs.test.ts` (create)

**Interfaces:**
- Consumes: existing `buildReferenceIndex(deps)`, `TmReference`, `ReferenceIndex`.
- Produces:
  - `RefTargetKind` extended to include `'element'`.
  - `TmReference.dimension?: string` (set only when `targetKind === 'element'`; the element's
    owning dimension).
  - `interface UnresolvedElementRef { section: RefSection; line: number; funcName: string;
    dimension?: string; expr: string; snippet: string; reason: 'dynamic' | 'param' }`.
  - `ReferenceIndex.byElement: Map<string, TmReference[]>` keyed by `elementKey(dim, element)`.
  - `ReferenceIndex.unresolvedElementRefsBySourceProcess: Map<string, UnresolvedElementRef[]>`
    (key = lowercased source process name).
  - Exported helper `elementKey(dimension: string, element: string): string` returning
    `` `${dimension.toLowerCase()} ${element.toLowerCase()}` `` (space-separated, both lowercased).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/callgraph-element-refs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildReferenceIndex, elementKey } from "../../src/lib/callgraph/referenceIndex.js";

// Shared minimal deps (mirror tests/unit/callgraph-global-ranking.test.ts shape:
// only process code varies; cubes/chores empty).
function indexOf(prolog: string) {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      { name: "P", prolog, metadata: "", data: "", epilog: "", parameters: [] },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

describe("byElement reverse index", () => {
  it("indexes a literal SubsetElementInsert element under (dim, element)", async () => {
    const index = await indexOf(
      "SubsetCreate('sTmp','Datenquellen',1);\nSubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);",
    );
    const refs = index.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"));
    expect(refs).toBeDefined();
    expect(refs!.map((r) => ({ kind: r.targetKind, dim: r.dimension, name: r.targetName, src: r.sourceName }))).toEqual([
      { kind: "element", dim: "Datenquellen", name: "SuDatenquellen_C", src: "P" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: FAIL — `elementKey` is not exported / `byElement` is undefined.

- [ ] **Step 3: Extend the type unions and `TmReference`**

In `referenceIndex.ts`, change line 47:

```ts
export type RefTargetKind = 'cube' | 'dimension' | 'process' | 'element';
```

In the `TmReference` interface (after `targetName`, ~line 78), add:

```ts
  /** Owning dimension — only set when targetKind === 'element'. */
  dimension?: string | undefined;
```

After the `UnresolvedCall` interface (~line 98), add:

```ts
/** A subset-membership element arg (SubsetElementInsert/Add/Delete) whose element name could not be resolved to a literal. */
export interface UnresolvedElementRef {
  section: RefSection;
  line: number;
  funcName: string;                    // SubsetElementInsert | SubsetElementAdd | SubsetElementDelete
  dimension?: string | undefined;      // may still resolve even when the element does not
  expr: string;                        // raw element-arg text, e.g. "sElem" or "CellGetS(...)"
  snippet: string;
  reason: 'dynamic' | 'param';
}
```

In the `ReferenceIndex` interface (after `unresolvedCallsBySourceProcess`, ~line 108), add:

```ts
  /** elementKey(dim, element) → element references (subset-membership calls). */
  byElement: Map<string, TmReference[]>;
  /** Process name (lowercased) → element args that could not be resolved to a literal. */
  unresolvedElementRefsBySourceProcess: Map<string, UnresolvedElementRef[]>;
```

- [ ] **Step 4: Add the `elementKey` helper**

In `referenceIndex.ts`, near the other exported helpers (after `splitArgs`, ~line 130), add:

```ts
/** Composite key for the byElement index: dimension + element, both lowercased. */
export function elementKey(dimension: string, element: string): string {
  return `${dimension.toLowerCase()} ${element.toLowerCase()}`;
}
```

- [ ] **Step 5: Bucket element refs in `buildReferenceIndex`**

Find where `byCube`/`byDim`/`byProcess` are populated from `all` (the bucketing loop that reads
`ref.targetKind`). Add a `byElement` map declaration next to the others:

```ts
const byElement = new Map<string, TmReference[]>();
```

In the same loop that switches on `ref.targetKind`, add an `element` branch (mirroring the
`byDim` push but keyed by `elementKey`):

```ts
} else if (ref.targetKind === 'element' && ref.dimension) {
  const k = elementKey(ref.dimension, ref.targetName);
  const arr = byElement.get(k) ?? [];
  arr.push(ref);
  byElement.set(k, arr);
}
```

Declare the unresolved-element collector next to `unresolvedCallsBySourceProcess`:

```ts
const unresolvedElementRefsBySourceProcess = new Map<string, UnresolvedElementRef[]>();
```

(It is populated in Task 2 via `pushTi`; for now it is emitted empty.)

Add both to the returned index object (the `return { all, byCube, byDim, … }` literal):

```ts
byElement,
unresolvedElementRefsBySourceProcess,
```

- [ ] **Step 6: Adjust the test for the phased split**

Element **emission** lands in Task 2; Task 1 only builds the model + buckets. So this task's test
cannot yet find the element ref. Temporarily weaken the Task-1 assertion to the model shape and
move the value assertion to Task 2 Step 5. Replace the `expect(refs)…` block from Step 1 with:

```ts
    // Model exists now; the actual element ref is emitted in Task 2 (SubsetElementInsert extraction).
    expect(index.byElement).toBeInstanceOf(Map);
```

(Task 2 restores the strong assertion.)

- [ ] **Step 7: Run test + typecheck**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: PASS (weakened assertion).
Run: `npm run typecheck`
Expected: PASS (new optional fields + maps are additive; no existing code reads `targetKind ===
'element'` yet).

- [ ] **Step 8: Commit**

```bash
git add src/lib/callgraph/referenceIndex.ts tests/unit/callgraph-element-refs.test.ts
git commit -m "feat(callgraph): add element RefTargetKind + byElement reverse index"
```

---

### Task 2: Extract element refs from subset-membership calls

**Files:**
- Modify: `src/lib/callgraph/referenceIndex.ts` (`extractTiReferences` push logic `280-309`; the
  `RawTiRef` type; `pushTi` in `buildReferenceIndex`)
- Test: `tests/unit/callgraph-element-refs.test.ts` (extend + restore Task-1 assertion)

**Interfaces:**
- Consumes: `elementKey`, `UnresolvedElementRef` (Task 1); `resolveExpression`,
  `extractStringLiteral`, `DIM_ARG_IDX`, `buildArgIdxMap` (existing).
- Produces:
  - Module const `ELEM_ARG_IDX = buildArgIdxMap('elementname')`.
  - Module const `SUBSET_ELEM_FUNCS = new Set(['subsetelementinsert','subsetelementadd','subsetelementdelete'])`.
  - `RawTiRef` gains `dimension?: string` (element owner) so `pushTi` can forward it.
  - `extractTiReferences(text, env?, sharedLiveVars?, unresolvedOut?, unresolvedElemOut?)` — a
    5th optional out-param `unresolvedElemOut?: RawUnresolvedElementRef[]` where
    `interface RawUnresolvedElementRef { line: number; funcName: string; dimension?: string; expr: string; snippet: string; reason: 'dynamic' | 'param' }`.

- [ ] **Step 1: Write the failing tests + restore Task-1 assertion**

In `tests/unit/callgraph-element-refs.test.ts`, restore the strong Task-1 assertion (revert Task 1
Step 6's weakening back to the `expect(refs!.map(...))` block from Task 1 Step 1). Then append:

```ts
import { extractTiReferences } from "../../src/lib/callgraph/referenceIndex.js";

describe("extractTiReferences — element refs from subset-membership calls", () => {
  it("emits an element ref (with dimension) for SubsetElementInsert", () => {
    const refs = extractTiReferences(
      "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el).toEqual([
      { line: 0, funcName: "SubsetElementInsert", targetKind: "element", targetName: "SuDatenquellen_C", dimension: "Datenquellen", snippet: "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);", params: undefined },
    ]);
  });

  it("handles SubsetElementAdd arg order (dim at index 1)", () => {
    const refs = extractTiReferences("SubsetElementAdd('sTmp','Kunde','K100');");
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([{ dim: "Kunde", name: "K100" }]);
  });

  it("resolves a variable dimension via live-var tracking", () => {
    const refs = extractTiReferences(
      "csDim = 'Datenquellen';\nSubsetElementInsert(csDim,'sTmp','SuDatenquellen_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([
      { dim: "Datenquellen", name: "SuDatenquellen_C" },
    ]);
  });

  it("surfaces a non-literal element arg as unresolved, not a resolved ref", () => {
    const unresolvedElem: unknown[] = [];
    const refs = extractTiReferences(
      "SubsetElementInsert('Datenquellen','sTmp',CellGetS('C','x'),1);",
      undefined,
      undefined,
      undefined,
      unresolvedElem as never,
    );
    expect(refs.filter((r) => r.targetKind === "element")).toEqual([]);
    expect(unresolvedElem).toEqual([
      { line: 0, funcName: "SubsetElementInsert", dimension: "Datenquellen", expr: "CellGetS('C','x')", snippet: "SubsetElementInsert('Datenquellen','sTmp',CellGetS('C','x'),1);", reason: "dynamic" },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: FAIL — no `targetKind === "element"` refs emitted; 5th arg ignored; restored byElement
assertion also fails.

- [ ] **Step 3: Add the element arg-index map + func set + raw types**

In `referenceIndex.ts`, after `PROCESS_ARG_IDX` (line 26), add:

```ts
const ELEM_ARG_IDX = buildArgIdxMap('elementname');

/** Subset-membership calls whose ElementName arg is a real element-data-flow reference. */
const SUBSET_ELEM_FUNCS = new Set(['subsetelementinsert', 'subsetelementadd', 'subsetelementdelete']);
```

Extend the internal `RawTiRef` interface (~line 156-164) with:

```ts
  dimension?: string;   // set for element refs (owning dimension)
```

Add a raw unresolved-element type next to `RawUnresolvedCall`:

```ts
interface RawUnresolvedElementRef {
  line: number;
  funcName: string;
  dimension?: string;
  expr: string;
  snippet: string;
  reason: 'dynamic' | 'param';
}
```

- [ ] **Step 4: Emit element refs in `extractTiReferences`**

Change the signature (line 217-222) to add the 5th out-param:

```ts
export function extractTiReferences(
  text: string,
  env?: ProcessEnv,
  sharedLiveVars?: Map<string, VarBinding>,
  unresolvedOut?: RawUnresolvedCall[],
  unresolvedElemOut?: RawUnresolvedElementRef[],
): RawTiRef[] {
```

Inside the `while ((m = FUNC_RE.exec(neutralized)) …)` loop, after the existing
`pushRef('process', …)` call (line 309), add an element block. An element ref needs BOTH the
element name and its dimension resolved together, so use a dedicated block (do not reuse the
single-arg `pushRef`):

```ts
if (SUBSET_ELEM_FUNCS.has(funcLower)) {
  const elemIdx = ELEM_ARG_IDX.get(funcLower);
  const dimIdx = DIM_ARG_IDX.get(funcLower);
  if (elemIdx !== undefined && elemIdx < args.length) {
    const elemArg = args[elemIdx]!;
    // Resolve the owning dimension (literal or var); undefined if unresolvable.
    let dimName: string | undefined;
    if (dimIdx !== undefined && dimIdx < args.length) {
      const dimArg = args[dimIdx]!;
      dimName = extractStringLiteral(dimArg) ?? undefined;
      if (dimName === undefined) {
        const db = resolveExpression(dimArg, callerEnv);
        if (db.kind === 'literal') dimName = db.value;
      }
    }
    let elemName = extractStringLiteral(elemArg);
    if (elemName === null) {
      const eb = resolveExpression(elemArg, callerEnv);
      if (eb.kind === 'literal') {
        elemName = eb.value;
      } else {
        if (unresolvedElemOut) {
          unresolvedElemOut.push({
            line: lineIdx,
            funcName: m![1]!,
            dimension: dimName,
            expr: elemArg.trim(),
            snippet,
            reason: eb.kind === 'param' ? 'param' : 'dynamic',
          });
        }
        elemName = null;
      }
    }
    if (elemName !== null) {
      refs.push({ line: lineIdx, funcName: m![1]!, targetKind: 'element', targetName: elemName, dimension: dimName, snippet, params: undefined });
    }
  }
}
```

> Note: `resolveExpression` returns a discriminated binding. The existing process-call branch uses
> `binding.kind === 'param'` (`referenceIndex.ts:295`). Use the SAME discriminant here. Confirm the
> exact string in `variableEnv.ts` (`VarBinding.kind`); if the runtime-parameter case is spelled
> `'passthrough'` there, change BOTH occurrences (here and Task 1's `UnresolvedElementRef` doc) to
> match — the two features must agree.

- [ ] **Step 5: Run the extraction + byElement tests**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: PASS (extraction tests + the restored byElement value assertion).

- [ ] **Step 6: Forward element refs + unresolved elems through `pushTi`**

In `buildReferenceIndex`, find `pushTi` (it calls `extractTiReferences(text, env, sharedLiveVars,
unresolvedOut)` and pushes each `RawTiRef` into `all`). Add a local unresolved-element buffer, pass
it as the 5th arg, and carry `dimension` in the `all.push`:

```ts
const unresolvedElemOut: RawUnresolvedElementRef[] = [];
for (const r of extractTiReferences(text, env, sharedLiveVars, unresolvedOut, unresolvedElemOut)) {
  all.push({
    sourceKind: 'process',
    sourceName,
    section,
    line: r.line,
    snippet: r.snippet,
    funcName: r.funcName,
    targetKind: r.targetKind,
    targetName: r.targetName,
    dimension: r.dimension,          // ← forward element owner
    params: r.params,
  });
}
if (unresolvedElemOut.length > 0) {
  const key = sourceName.toLowerCase();
  const arr = unresolvedElementRefsBySourceProcess.get(key) ?? [];
  for (const u of unresolvedElemOut) { arr.push({ section, ...u }); }
  unresolvedElementRefsBySourceProcess.set(key, arr);
}
```

- [ ] **Step 7: Add an index-level test for unresolved element refs**

Append to `tests/unit/callgraph-element-refs.test.ts`:

```ts
describe("buildReferenceIndex — unresolvedElementRefsBySourceProcess", () => {
  it("buckets a dynamic element arg per source process", async () => {
    const index = await indexOf("SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);");
    expect(index.unresolvedElementRefsBySourceProcess.get("p")).toEqual([
      { section: "prolog", line: 0, funcName: "SubsetElementInsert", dimension: "Kunde", expr: "CellGetS('C','x')", snippet: "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);", reason: "dynamic" },
    ]);
  });
});
```

- [ ] **Step 8: Run tests + full verify**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: PASS (all element tests).
Run: `npm run verify`
Expected: green. (Watch for existing callgraph fixture tests that snapshot `index.all` or ref
counts — the new `dimension` field is optional and element refs are new rows; if a strict
equality fixture breaks because subset-membership funcs now also emit an element row, update that
fixture to include the element ref. Name which fixture in the commit message.)

- [ ] **Step 9: Commit**

```bash
git add src/lib/callgraph/referenceIndex.ts tests/unit/callgraph-element-refs.test.ts
git commit -m "feat(callgraph): extract element refs from SubsetElementInsert/Add/Delete (dim+element, unresolved surfaced)"
```

---

### Task 3: `tm1_trace_data_flow` element filter + per-process elements

**Files:**
- Modify: `src/lib/callgraph/dataFlow.ts` (`DataFlowResult`, `DownstreamReader`, `UpstreamWriter`,
  `traceDataFlow` signature + body `137-180`, top-of-file import)
- Modify: `src/tools/analysis/trace-data-flow.ts` (input schema + handler)
- Modify: `src/tools/schemas/items.ts` (`DataFlowResultSchema` `850-878`)
- Test: `tests/unit/data-flow.test.ts` (extend; if absent, create with the `indexOf` harness)

**Interfaces:**
- Consumes: `ReferenceIndex.byElement`, `elementKey`, `bySourceProcess`,
  `unresolvedElementRefsBySourceProcess` (Tasks 1-2).
- Produces:
  - `traceDataFlow(index, dsList, cubeName, direction, opts?)` where
    `opts?: { element?: { dimension: string; name: string } }`.
  - `DataFlowResult.element?: { dimension: string; name: string; processes: Array<{ process:
    string; funcNames: string[] }>; unresolvedInProcesses?: string[] }` — populated only when
    `opts.element` is set.
  - `DownstreamReader.elements?: string[]` and `UpstreamWriter.elements?: string[]` — in-code
    subset-membership elements that process manipulates.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/data-flow.test.ts` (reuse its `buildReferenceIndex` harness; if the file does
not exist, create it importing `buildReferenceIndex` and `traceDataFlow` and defining the same
`indexOf` helper as in `callgraph-element-refs.test.ts`):

```ts
import { traceDataFlow } from "../../src/lib/callgraph/dataFlow.js";

describe("traceDataFlow — element filter", () => {
  it("lists processes that touch a given element of a dimension", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "Builder", prolog: "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Datenquellen", name: "SuDatenquellen_C" },
    });
    expect(flow.element).toEqual({
      dimension: "Datenquellen",
      name: "SuDatenquellen_C",
      processes: [{ process: "Builder", funcNames: ["SubsetElementInsert"] }],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: FAIL — `traceDataFlow` takes 4 args; `flow.element` undefined.

- [ ] **Step 3: Extend the dataFlow types**

In `dataFlow.ts`, add to `DownstreamReader` (after `readsVia`) and `UpstreamWriter` (after
`externalSource`):

```ts
  /** In-code subset-membership elements this process manipulates (SubsetElementInsert/Add/Delete). */
  elements?: string[];
```

Add to `DataFlowResult` (after `downstream?`):

```ts
  /** Present only when an element filter was supplied — processes that touch element (dimension, name). */
  element?: {
    dimension: string;
    name: string;
    processes: Array<{ process: string; funcNames: string[] }>;
    /** Processes where this dimension has an UNRESOLVED element arg (element identity not statically known). */
    unresolvedInProcesses?: string[];
  };
```

- [ ] **Step 4: Add the element query + per-process elements to `traceDataFlow`**

At the top of `dataFlow.ts`, replace the `import type { ReferenceIndex } from "./referenceIndex.js";`
line with a value+type import (needs `elementKey` at runtime):

```ts
import { elementKey, type ReferenceIndex } from "./referenceIndex.js";
```

Change the signature:

```ts
export function traceDataFlow(
  index: ReferenceIndex,
  dsList: DataSourceEntry[],
  cubeName: string,
  direction: Direction,
  opts?: { element?: { dimension: string; name: string } },
): DataFlowResult {
```

In the downstream loop, after computing `readsVia` and before `readers.push`:

```ts
const elements = elementsForProcess(index, e.orig);
readers.push({ process: e.orig, targetCubes, readsVia, ...(elements.length ? { elements } : {}) });
```

In the upstream loop, add `elements` to the `writers.push({…})` object literal:

```ts
const elements = elementsForProcess(index, e.orig);
writers.push({
  process: e.orig,
  sourceCubes,
  datasourceType: e.dsType,
  ...(e.externalSource ? { externalSource: e.externalSource } : {}),
  ...(elements.length ? { elements } : {}),
});
```

At the end of the function, before `return result;`, add the element filter:

```ts
if (opts?.element) {
  const { dimension, name } = opts.element;
  const refs = index.byElement.get(elementKey(dimension, name)) ?? [];
  const byProc = new Map<string, Set<string>>();
  for (const r of refs) {
    const set = byProc.get(r.sourceName) ?? new Set<string>();
    if (r.funcName) set.add(r.funcName);
    byProc.set(r.sourceName, set);
  }
  const processes = [...byProc.entries()]
    .map(([process, fns]) => ({ process, funcNames: [...fns].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.process.localeCompare(b.process));
  const unresolvedInProcesses = [...index.unresolvedElementRefsBySourceProcess.entries()]
    .filter(([, list]) => list.some((u) => (u.dimension ?? "").toLowerCase() === dimension.toLowerCase()))
    .map(([proc]) => proc)
    .sort((a, b) => a.localeCompare(b));
  result.element = {
    dimension,
    name,
    processes,
    ...(unresolvedInProcesses.length ? { unresolvedInProcesses } : {}),
  };
}
```

Add the helper near `buildProcessIO`:

```ts
/** In-code subset-membership element names a process manipulates, sorted & de-duped. */
function elementsForProcess(index: ReferenceIndex, processOrig: string): string[] {
  const refs = index.bySourceProcess.get(processOrig.toLowerCase()) ?? [];
  const names = new Set<string>();
  for (const r of refs) { if (r.targetKind === "element") names.add(r.targetName); }
  return [...names].sort((a, b) => a.localeCompare(b));
}
```

> `bySourceProcess` keys are lowercased process names (`referenceIndex.ts:105-106`); hence
> `processOrig.toLowerCase()`. Confirm `bySourceProcess` is populated for element refs — it is, if
> it buckets every `all` row by `sourceName`; if it filters by `targetKind`, add `'element'` to its
> allow-list in `buildReferenceIndex`.

- [ ] **Step 5: Run the dataFlow test**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the tool input + handler**

In `src/tools/analysis/trace-data-flow.ts`, add two optional inputs (after `includeControl`):

```ts
      element: z
        .string()
        .optional()
        .describe("Element name to trace. With 'dimension', results add which processes touch this element via in-code subset-membership calls (SubsetElementInsert/Add/Delete)."),
      dimension: z
        .string()
        .optional()
        .describe("Owning dimension of 'element' (required when 'element' is set)."),
```

Change the handler to destructure + guard + pass through:

```ts
    async ({ cubeName, direction, includeControl, element, dimension }) => {
      if (element && !dimension) {
        return { isError: true, content: [{ type: "text" as const, text: "When 'element' is set, 'dimension' is required (element names are only unique within a dimension)." }] };
      }
      const [index, dsList] = await Promise.all([
        buildIndexFromTM1(tm1Client, { includeControl }),
        tm1Client.processes.listDataSources(includeControl),
      ]);

      const flow = traceDataFlow(index, dsList, cubeName, direction, element && dimension ? { element: { dimension, name: element } } : undefined);
```

Append a sentence to the tool description `.join(" ")` array:

```ts
      "Pass element+dimension to also get which processes touch that element via in-code subset-membership calls.",
```

- [ ] **Step 7: Extend `DataFlowResultSchema` (same task — strict schema)**

In `src/tools/schemas/items.ts`, inside `DataFlowResultSchema`:

Add `elements` to BOTH the upstream row object (~`856-861`) and the downstream row object
(~`866-870`):

```ts
        elements: z.array(z.string()).optional(),
```

Add the `element` block (after `counts`, before `hint`):

```ts
  element: z
    .object({
      dimension: z.string(),
      name: z.string(),
      processes: z.array(z.object({ process: z.string(), funcNames: z.array(z.string()) })),
      unresolvedInProcesses: z.array(z.string()).optional(),
    })
    .optional(),
```

- [ ] **Step 8: Run tests + full verify**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: PASS.
Run: `npm run verify`
Expected: green (typecheck + lint:no-flat-api + lint:annotations + tests + output-schema-map).
If `output-schema-map` has a `tm1_trace_data_flow` fixture, add an `element` example to it so the
strict schema round-trips.

- [ ] **Step 9: Regenerate README tool docs + commit**

Run: `npm run tools:update-readme`

```bash
git add src/lib/callgraph/dataFlow.ts src/tools/analysis/trace-data-flow.ts src/tools/schemas/items.ts tests/unit/data-flow.test.ts README.md
git commit -m "feat(trace-data-flow): element+dimension filter (processes touching an element) + per-process elements"
```

---

### Task 4: Live validation + docs

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- (Live probe — controller-driven, no file change)

**Interfaces:** none (docs + manual live probe).

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- Callgraph now tracks an **element** grain for subset-membership calls
  (`SubsetElementInsert`/`SubsetElementAdd`/`SubsetElementDelete`): the element name + owning
  dimension are indexed, and non-literal element args are surfaced as unresolved (not silently
  dropped).
- `tm1_trace_data_flow` accepts optional `element` + `dimension` inputs to answer
  "which processes touch element X of dimension D" (via in-code subset-membership calls), and
  each data-flow row now lists the in-code elements that process manipulates. Reads through
  **stored** view/subset MDX remain cube-level only — see the Bucket B follow-up.
```

- [ ] **Step 2: Live probe (against tm1-test)**

Create a synthetic process that builds a subset in code, then query it:

```
tm1_upsert_process(name="zElemTraceTest", mode="create",
  prolog="csDim='Datenquellen';\nSubsetCreate('sTmp',csDim,1);\nSubsetElementInsert(csDim,'sTmp','SuDatenquellen_C',1);")
tm1_trace_data_flow(cubeName="ZusaetzlicheFahrten", direction="both", element="SuDatenquellen_C", dimension="Datenquellen")
→ expect flow.element.processes to contain { process: "zElemTraceTest", funcNames: ["SubsetElementInsert"] }
tm1_delete_process(processName="zElemTraceTest", confirm="zElemTraceTest")
```

(Use a dimension that exists on the target server — confirm one via `tm1_list_dimensions`;
`Datenquellen` is illustrative. The element name need not exist for the index to record the code
reference.)

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(trace-data-flow): changelog for element-grain + element filter"
```

---

## Notes for the executor

- **No new REST in this plan.** Everything reads the existing `buildIndexFromTM1` +
  `listDataSources`. Do not add a service call.
- **`resolveExpression` discriminant:** confirm whether the non-literal param case is `'param'`
  or `'passthrough'` in `variableEnv.ts` and use it consistently (Task 2 Step 4 note).
- **`SubsetElementInsert` vs `Add`/`Delete` arg order differs** — never hardcode positions; the
  `buildArgIdxMap('elementname')` / `buildArgIdxMap('dimensionname')` maps give the correct
  per-function index.
- **`SubsetElementDelete`** is included as a membership touch (it proves the process manipulates
  that element). Distinguishing removal from insertion (an `access` tag on the element ref) is a
  future refinement, out of scope here — recorded as a plain touch.
- **Deliberately out of scope (own follow-up plan — Bucket B):** fetching **stored** view MDX /
  subset expressions from the server and scoped-literal-matching the target element inside them.
  That adds new REST (view/subset definition reads in a service) + a matcher, and is a separate
  subsystem. **Bucket C** (computed membership: `TM1FILTERBYLEVEL`, `DESCENDANTS`, attribute
  filters — element never literal) stays deferred and MUST be flagged, never implied absent.
- **Full 69-func element auto-derivation was rejected on purpose.** `buildArgIdxMap('elementname')`
  matches ~69 functions (ElementDelete, AttrPut*, etc.); Phase 1 gates emission to
  `SUBSET_ELEM_FUNCS` (the 3 subset-membership funcs) to keep the blast radius tight and the
  output focused on data-flow-relevant element usage. Widening later is additive.

## Self-review

- **Spec coverage:** Bucket A (in-code subset build) → Tasks 1-3. Element grain / `RefTargetKind`
  → Task 1. Unresolved element surfacing (decision 3) → Task 2. Element filter on
  `trace_data_flow` (decision 2) → Task 3. Precise attribution (decision 1): per-process element
  lists + the reverse `byElement` query answer "who touches element X" exactly; finer
  view-name↔subset-name chaining was judged fragile-for-marginal-gain (typically one datasource
  per process) and folded into per-process attribution — noted, not silently dropped. Bucket B/C
  (decision 4, scope A+B): B is carved into its own plan per the writing-plans "separate
  subsystem" rule (it adds REST); this document is Phase 1 (A). **Write the Bucket B plan next.**
- **Placeholders:** none — every code step shows the code.
- **Type consistency:** `elementKey`, `byElement`, `UnresolvedElementRef`,
  `unresolvedElementRefsBySourceProcess`, `RawTiRef.dimension`, `TmReference.dimension`,
  `traceDataFlow(…, opts?)`, `DataFlowResult.element`, `DownstreamReader.elements`,
  `UpstreamWriter.elements`, `elementsForProcess` — used with the same names across Tasks 1-3.
