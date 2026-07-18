# Element Usage Classification (Phase 1.5) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Phase 1 (Bucket A), merged at `1573f45`.** Reuses the element grain: `RefTargetKind='element'`, `TmReference.dimension`, `byElement`, `elementKey`, `DataFlowResult.element`, the tool `element`/`dimension` filter.

**Goal:** Classify each Bucket-A element→process attribution by how the subset the element was inserted
into is actually used in that process — `source` (read), `write`, `zero-out`, or honest
`indeterminate` — so `tm1_trace_data_flow` distinguishes "processes element X onward" from "zeroes out
X's region" and never claims a built-but-unclassified subset is unused.

**Architecture:** Model B (process-level). The element ref carries the resolved subset handle it was
inserted into. A pure per-process scan (`subsetUsage.ts`) records, per subset handle, how it is used
in that process's TI: which view it is `ViewSubsetAssign`-ed to, whether that view is `ViewZeroOut`-ed,
and whether the subset is iterated by an index loop alongside cell reads/writes. `traceDataFlow` then
joins element→subset→usage AND the process datasource (`dsList`) to compute an `access: AccessKind[]`,
filtered by a new `elementAccess` input.

**Tech Stack:** TypeScript (strict), vitest. Pure functions in `src/lib/callgraph/`; MCP handler in
`src/tools/analysis/`; Zod schema in `src/tools/schemas/items.ts`.

## Global Constraints

- Pure analysis, NO new REST (uses existing index + `dsList` from `listDataSources`).
- Strict output schema: new `element` fields land in `DataFlowResultSchema` (`items.ts`) in the SAME
  task. Output-schema-budget is at **96.6% of the 82000-byte cap** — if a schema addition pushes
  `lint:output-schema-budget` over, STOP and report; do not silently raise the cap.
- No new tool; `tm1_trace_data_flow` stays read-only.
- `AccessKind = 'source' | 'write' | 'zero-out' | 'indeterminate'` — one spelling, used identically
  across index, dataFlow, schema, tool.
- Default `elementAccess = ['source','write','zero-out']`; `indeterminate` is opt-in; a
  suppressed-`indeterminate` COUNT is always reported (honesty — never silently drop, never assert
  "unused").
- Conventional Commits; one logical change per commit; synthetic names in tests.
- After tool description change: `npm run tools:update-readme`.

## Verified current-state facts (do not re-derive)

- Element extraction block emits element refs for `SUBSET_ELEM_FUNCS`
  (`subsetelementinsert`/`add`/`delete`) in `extractTiReferences`, using `ELEM_ARG_IDX`/`DIM_ARG_IDX`
  (`buildArgIdxMap(...)`), and forwards `dimension` through `RawTiRef`→`pushTi`→`all`. Element
  `TmReference` has `dimension?`. `src/lib/callgraph/referenceIndex.ts` (element block after
  `pushRef('process',...)`; `pushTi` in `buildReferenceIndex`).
- `buildReferenceIndex` loops `for (const p of processes)` and already computes
  `const combinedText = [p.prolog, p.metadata, p.data, p.epilog].join('\n')` (`referenceIndex.ts:557`)
  — the natural input for a per-process usage scan. `ProcessFetchResult` has `prolog/metadata/data/
  epilog/parameters` (`:456`). The datasource is NOT here (it comes from `dsList` at query time).
- Signature arg orders (from `tiSignatures.ts`, positions VARY — use `buildArgIdxMap`, never hardcode):
  - `SubsetElementInsert(Dim[0], Subset[1], Elem[2], Pos[3])`; `SubsetElementAdd(Subset[0], Dim[1],
    Elem[2])`; `SubsetElementDelete(Subset[0], Dim[1], Elem[2])`.
  - `ViewSubsetAssign(Cube[0], View[1], Dim[2], Subset[3])` (`:2876`).
  - `ViewZeroOut(Cube[0], View[1])` (`:4685`).
  - `SubsetGetElementName(Subset[0], Dim[1], Index[2])` (`:2742`); `SubsetGetSize(Subset[0], Dim[1])`
    (`:2753`).
- `classifyAccess(funcName, 'process'): 'read'|'write'|'other'` (`callGraph.ts:276`). `WRITE_FUNCS`
  includes `cellputn/cellputs/cellincrementn/viewzeroout/cubecleardata/…`; `READ_FUNCS` includes
  `cellgetn/cellgets/cellexists/…`. It is funcName-only — it does NOT inspect args (so "CellPutN with
  literal 0" needs a separate arg check for `zero-out`).
- `traceDataFlow(index, dsList, cubeName, direction, opts?)` — `opts.element` filter builds
  `result.element` from `index.byElement.get(elementKey(...))` + `unresolvedElementRefsBySourceProcess`.
  `DataFlowResult.element` = `{ dimension; name; processes: {process; funcNames; via?}[];
  unresolvedInProcesses?; computedInProcesses?; resolution }`. `dsList` entries:
  `{ name; type; sourceName?; view?; subset? }` (`dataFlow.ts` `DataSourceEntry`). `elementsForProcess`
  reads `bySourceProcess` (unconditional on targetKind). Schema `DataFlowResultSchema.element` in
  `items.ts` (~`850-895` post-Bucket-A).

---

### Task 1: Carry the subset handle on element refs

**Files:**
- Modify: `src/lib/callgraph/referenceIndex.ts` (element extraction block; `RawTiRef`; `TmReference`; `pushTi`)
- Test: `tests/unit/callgraph-element-refs.test.ts` (extend)

**Interfaces:**
- Produces:
  - `TmReference.subset?: string | undefined` (set for element refs — the subset the element was inserted into).
  - `RawTiRef.subset?: string | undefined` (forwarded).
  - Module const `SUBSET_ARG_IDX = buildArgIdxMap('subsetname')`.

- [ ] **Step 1: Failing test**

Append to `tests/unit/callgraph-element-refs.test.ts`:

```ts
describe("element ref carries its subset handle", () => {
  it("attaches the resolved subset name for SubsetElementInsert", () => {
    const refs = extractTiReferences("SubsetElementInsert('Currency','sTmp','USD',1);");
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName, subset: r.subset }))).toEqual([
      { dim: "Currency", name: "USD", subset: "sTmp" },
    ]);
  });
  it("resolves a variable subset handle", () => {
    const refs = extractTiReferences("csSub='sTmp';\nSubsetElementAdd(csSub,'Currency','USD');");
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el[0]!.subset).toBe("sTmp");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts`
Expected: FAIL — `r.subset` is undefined.

- [ ] **Step 3: Add `SUBSET_ARG_IDX` + type fields**

In `referenceIndex.ts` after `ELEM_ARG_IDX`:

```ts
const SUBSET_ARG_IDX = buildArgIdxMap('subsetname');
```

Add to `TmReference` (after `dimension?`):

```ts
  /** For element refs: the subset the element was inserted into (resolved when possible). */
  subset?: string | undefined;
```

Add to `RawTiRef` (after its `dimension?`):

```ts
  subset?: string | undefined;
```

- [ ] **Step 4: Resolve + attach subset in the element block**

In the element block of `extractTiReferences` (where `elemName`/`dimName` are resolved), add subset
resolution mirroring `dimName`, and include it on the pushed ref:

```ts
    let subName: string | undefined;
    const subIdx = SUBSET_ARG_IDX.get(funcLower);
    if (subIdx !== undefined && subIdx < args.length) {
      const subArg = args[subIdx]!;
      subName = extractStringLiteral(subArg) ?? undefined;
      if (subName === undefined) {
        const sb = resolveExpression(subArg, callerEnv);
        if (sb.kind === 'literal') subName = sb.value;
      }
    }
```

and change the element `refs.push({...})` to include `subset: subName`:

```ts
      refs.push({ line: lineIdx, funcName: m![1]!, targetKind: 'element', targetName: elemName, dimension: dimName, subset: subName, snippet, params: undefined });
```

- [ ] **Step 5: Forward through `pushTi`**

In `buildReferenceIndex`'s `pushTi`, add `subset: r.subset` to the element-carrying `all.push({...})`
mapping (next to `dimension: r.dimension`).

- [ ] **Step 6: Run — expect PASS + typecheck**

Run: `npx vitest run tests/unit/callgraph-element-refs.test.ts` → PASS.
Run: `npm run typecheck` → PASS (note: `exactOptionalPropertyTypes` requires `subset?: string |
undefined` exactly as written on both types — already so).

- [ ] **Step 7: Commit**

```bash
git add src/lib/callgraph/referenceIndex.ts tests/unit/callgraph-element-refs.test.ts
git commit -m "feat(callgraph): carry resolved subset handle on element refs"
```

---

### Task 2: Per-process subset usage index

**Files:**
- Create: `src/lib/callgraph/subsetUsage.ts`
- Modify: `src/lib/callgraph/referenceIndex.ts` (`ReferenceIndex` type; build `subsetUsageByProcess`; export `splitArgs`/`extractStringLiteral` if not already exported)
- Test: `tests/unit/subset-usage.test.ts`

**Interfaces:**
- Consumes: `buildProcessEnv`/`resolveExpression`/`ProcessEnv` (variableEnv), `splitArgs`/
  `extractStringLiteral` (referenceIndex), `classifyAccess` (callGraph).
- Produces:
  - `interface ViewUsage { view?: string; cube?: string; zeroOut: boolean }`
  - `interface SubsetUsage { subset: string; resolved: boolean; views: ViewUsage[]; loopRead: boolean; loopWrite: boolean; loopZero: boolean }`
  - `function extractSubsetUsage(text: string, env?: ProcessEnv): Map<string /* lc subset */, SubsetUsage>`
  - `ReferenceIndex.subsetUsageByProcess: Map<string /* lc process */, Map<string /* lc subset */, SubsetUsage>>`

- [ ] **Step 1: Failing tests**

Create `tests/unit/subset-usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractSubsetUsage } from "../../src/lib/callgraph/subsetUsage.js";

describe("extractSubsetUsage", () => {
  it("links a subset to a view via ViewSubsetAssign", () => {
    const u = extractSubsetUsage("ViewSubsetAssign('Sales','vTmp','Currency','sTmp');");
    expect(u.get("stmp")?.views).toEqual([{ view: "vTmp", cube: "Sales", zeroOut: false }]);
  });
  it("marks zero-out when the assigned view is ViewZeroOut'd", () => {
    const u = extractSubsetUsage(
      "ViewSubsetAssign('Sales','vTmp','Currency','sTmp');\nViewZeroOut('Sales','vTmp');",
    );
    expect(u.get("stmp")?.views[0]?.zeroOut).toBe(true);
  });
  it("detects a loop read: SubsetGetElementName + CellGetN", () => {
    const u = extractSubsetUsage(
      "sEl=SubsetGetElementName('sTmp','Currency',1);\nnV=CellGetN('Sales',sEl);",
    );
    expect(u.get("stmp")?.loopRead).toBe(true);
    expect(u.get("stmp")?.loopWrite).toBe(false);
  });
  it("detects a loop write and a literal-zero as loopZero", () => {
    const u = extractSubsetUsage(
      "sEl=SubsetGetElementName('sTmp','Currency',1);\nCellPutN(0,'Sales',sEl);",
    );
    expect(u.get("stmp")?.loopWrite).toBe(true);
    expect(u.get("stmp")?.loopZero).toBe(true);
  });
  it("flags an unresolved subset handle without guessing", () => {
    const u = extractSubsetUsage("ViewSubsetAssign('Sales','vTmp','Currency',pSub);");
    const only = [...u.values()][0]!;
    expect(only.resolved).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/unit/subset-usage.test.ts`) — module missing.

- [ ] **Step 3: Implement `subsetUsage.ts`**

Create `src/lib/callgraph/subsetUsage.ts`:

```ts
// Pure per-process scan classifying how each subset handle is USED in a process's TI.
// Feeds element usage classification (source / write / zero-out / indeterminate).
// NOT a datasource check — the process datasource lives in dsList and is joined at
// query time in traceDataFlow.

import { buildProcessEnv, resolveExpression, type ProcessEnv } from "./variableEnv.js";
import { splitArgs, extractStringLiteral } from "./referenceIndex.js";
import { classifyAccess } from "./callGraph.js";

export interface ViewUsage {
  view?: string;
  cube?: string;
  zeroOut: boolean;
}
export interface SubsetUsage {
  subset: string;
  resolved: boolean;
  views: ViewUsage[];
  loopRead: boolean;
  loopWrite: boolean;
  loopZero: boolean;
}

const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/gi;

function resolveArg(raw: string | undefined, env: ProcessEnv): { value?: string; resolved: boolean } {
  if (raw === undefined) return { resolved: false };
  const lit = extractStringLiteral(raw);
  if (lit !== null) return { value: lit, resolved: true };
  const b = resolveExpression(raw, env);
  if (b.kind === "literal") return { value: b.value, resolved: true };
  return { resolved: false };
}

export function extractSubsetUsage(text: string, env?: ProcessEnv): Map<string, SubsetUsage> {
  const baseEnv = env ?? buildProcessEnv(text, []);
  const usage = new Map<string, SubsetUsage>();
  const viewToSubsets = new Map<string, string[]>(); // lc "cube view" -> subset lc keys
  let synth = 0;

  const getBucket = (subLc: string, subName: string | undefined, resolved: boolean): SubsetUsage => {
    let u = usage.get(subLc);
    if (!u) {
      u = { subset: subName ?? "", resolved, views: [], loopRead: false, loopWrite: false, loopZero: false };
      usage.set(subLc, u);
    }
    if (!resolved) u.resolved = false;
    return u;
  };

  // Process-wide read/write presence (loose loop-body heuristic — see plan note).
  let hasCellRead = false;
  let hasCellWrite = false;
  let hasZeroWrite = false;
  const iteratedSubsets = new Set<string>();

  const lines = text.split("\n");
  for (const line of lines) {
    let m: RegExpExecArray | null;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(line)) !== null) {
      const fn = m[1]!.toLowerCase();
      const open = m.index + m[0].length - 1;
      const argStr = sliceArgs(line, open);
      const args = argStr === null ? [] : splitArgs(argStr);

      if (fn === "viewsubsetassign") {
        const cube = resolveArg(args[0], baseEnv);
        const view = resolveArg(args[1], baseEnv);
        const sub = resolveArg(args[3], baseEnv);
        const subLc = sub.value?.toLowerCase() ?? `__unresolved_${synth++}`;
        const u = getBucket(subLc, sub.value, sub.resolved && view.resolved);
        u.views.push({ view: view.value, cube: cube.value, zeroOut: false });
        if (view.resolved && cube.value !== undefined) {
          const vk = `${cube.value.toLowerCase()} ${view.value!.toLowerCase()}`;
          const arr = viewToSubsets.get(vk) ?? [];
          arr.push(subLc);
          viewToSubsets.set(vk, arr);
        }
      } else if (fn === "viewzeroout") {
        const cube = resolveArg(args[0], baseEnv);
        const view = resolveArg(args[1], baseEnv);
        if (cube.resolved && view.resolved) {
          const vk = `${cube.value!.toLowerCase()} ${view.value!.toLowerCase()}`;
          for (const subLc of viewToSubsets.get(vk) ?? []) {
            const u = usage.get(subLc);
            if (u) for (const v of u.views) {
              if (v.cube?.toLowerCase() === cube.value!.toLowerCase() && v.view?.toLowerCase() === view.value!.toLowerCase()) v.zeroOut = true;
            }
          }
        }
      } else if (fn === "subsetgetelementname" || fn === "subsetgetsize") {
        const sub = resolveArg(args[0], baseEnv);
        if (sub.resolved) iteratedSubsets.add(sub.value!.toLowerCase());
      } else {
        const access = classifyAccess(m[1]!, "process");
        if (access === "read") hasCellRead = true;
        else if (access === "write") {
          hasCellWrite = true;
          if ((fn === "cellputn" || fn === "cellincrementn") && isLiteralZero(args[0])) hasZeroWrite = true;
          if (fn === "viewzeroout") hasZeroWrite = true;
        }
      }
    }
  }

  // Attribute the process-wide loop read/write to each iterated subset (loose heuristic).
  for (const subLc of iteratedSubsets) {
    const u = getBucket(subLc, subLc, true);
    if (hasCellRead) u.loopRead = true;
    if (hasCellWrite) u.loopWrite = true;
    if (hasZeroWrite) u.loopZero = true;
  }

  return usage;
}

function isLiteralZero(raw: string | undefined): boolean {
  return raw !== undefined && raw.trim() === "0";
}

// Extract the substring between the '(' at openIdx and its matching ')' on the same line.
function sliceArgs(line: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return line.slice(openIdx + 1, i); }
  }
  return null;
}
```

> **Plan note (loose loop heuristic — the spec's one open point):** `loopRead`/`loopWrite` are
> attributed to any subset the process *iterates* (`SubsetGetElementName`/`SubsetGetSize` on it) when
> the process contains a cell read/write anywhere. This can over-attribute if the cell op is unrelated
> to the iterated subset. That is the deliberate looseness the spec accepted; the consumer (Task 3)
> treats loop-derived `source`/`write` as valid but the whole feature reports `resolution` honestly.
> If the reviewer deems it too loose, tighten to same-`WHILE`-block scoping in a follow-up — do NOT
> silently emit a confident tag you cannot justify. If `splitArgs`/`extractStringLiteral` are not
> exported from `referenceIndex.ts`, export them (they are pure helpers) as part of this task.

- [ ] **Step 4: Run — expect PASS** (`npx vitest run tests/unit/subset-usage.test.ts`).

- [ ] **Step 5: Wire `subsetUsageByProcess` into the index**

Add to `ReferenceIndex` (after `unresolvedElementRefsBySourceProcess`):

```ts
  /** Process (lc) → subset (lc) → how that subset is used in the process (view assign / zero-out / loop). */
  subsetUsageByProcess: Map<string, Map<string, SubsetUsage>>;
```

Import `SubsetUsage`/`extractSubsetUsage` at the top of `referenceIndex.ts`. In `buildReferenceIndex`,
declare `const subsetUsageByProcess = new Map<string, Map<string, SubsetUsage>>();` before the
`for (const p of processes)` loop, and inside it (using the existing `combinedText` at `:557` and the
process `env`):

```ts
subsetUsageByProcess.set(p.name.toLowerCase(), extractSubsetUsage(combinedText, env));
```

Add `subsetUsageByProcess` to the returned index object.

- [ ] **Step 6: Run full verify + commit**

Run: `npm run verify` → green.

```bash
git add src/lib/callgraph/subsetUsage.ts src/lib/callgraph/referenceIndex.ts tests/unit/subset-usage.test.ts
git commit -m "feat(callgraph): per-process subset usage index (view-assign/zero-out/loop)"
```

---

### Task 3: Classify element access in traceDataFlow + tool filter

**Files:**
- Modify: `src/lib/callgraph/dataFlow.ts` (`AccessKind`; `DataFlowResult.element`; `traceDataFlow`)
- Modify: `src/tools/analysis/trace-data-flow.ts` (input `elementAccess`)
- Modify: `src/tools/schemas/items.ts` (`DataFlowResultSchema.element`)
- Test: `tests/unit/data-flow.test.ts`

**Interfaces:**
- Consumes: `ReferenceIndex.byElement` (refs now carry `subset`), `subsetUsageByProcess`, `SubsetUsage`,
  `elementKey`, `dsList`.
- Produces:
  - `export type AccessKind = 'source' | 'write' | 'zero-out' | 'indeterminate';`
  - `traceDataFlow(..., opts?: { element?; datasourceMembership?; elementAccess?: AccessKind[] })`.
  - `DataFlowResult.element.processes[]` gains `access: AccessKind[]`.
  - `DataFlowResult.element` gains `suppressedIndeterminate?: number`.

- [ ] **Step 1: Failing tests**

Append to `tests/unit/data-flow.test.ts`:

```ts
describe("traceDataFlow — element access classification", () => {
  async function idx(prolog: string) {
    return buildReferenceIndex({
      fetchProcesses: async () => [{ name: "P", prolog, metadata: "", data: "", epilog: "", parameters: [] }],
      fetchCubesWithRules: async () => [], fetchChores: async () => [],
    });
  }
  it("tags zero-out when the element's subset feeds a ViewZeroOut", async () => {
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','vTmp','Currency','sTmp');\nViewZeroOut('Sales','vTmp');",
    );
    const flow = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out"] });
    expect(flow.element!.processes).toEqual([{ process: "P", funcNames: ["SubsetElementInsert"], access: ["zero-out"] }]);
  });
  it("tags source when the element's subset feeds the process view datasource", async () => {
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','vTmp','Currency','sTmp');",
    );
    const ds = [{ name: "P", type: "TM1CubeView", sourceName: "Sales", view: "vTmp" }];
    const flow = traceDataFlow(index, ds, "Sales", "both",
      { element: { dimension: "Currency", name: "USD" } });
    expect(flow.element!.processes[0]!.access).toEqual(["source"]);
  });
  it("indeterminate is opt-in and counted when suppressed", async () => {
    const index = await idx("SubsetElementInsert('Currency','sTmp','USD',1);"); // built, never used
    const flow = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" } }); // default excludes indeterminate
    expect(flow.element!.processes).toEqual([]);
    expect(flow.element!.suppressedIndeterminate).toBe(1);
    const flow2 = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out","indeterminate"] });
    expect(flow2.element!.processes[0]!.access).toEqual(["indeterminate"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/unit/data-flow.test.ts`).

- [ ] **Step 3: Add `AccessKind` + a classifier helper in `dataFlow.ts`**

Add near the top of `dataFlow.ts`:

```ts
export type AccessKind = 'source' | 'write' | 'zero-out' | 'indeterminate';
```

Import the usage type: `import type { SubsetUsage } from "./subsetUsage.js";`

Add a helper (module scope):

```ts
function classifyElementAccess(
  usageForProcess: Map<string, SubsetUsage> | undefined,
  subsetsForElement: string[],   // lc subset handles this element was inserted into, in this process
  ds: DataSourceEntry | undefined,
): AccessKind[] {
  const kinds = new Set<AccessKind>();
  for (const subLc of subsetsForElement) {
    const u = usageForProcess?.get(subLc);
    if (ds?.type === "TM1DimensionSubset" && ds.subset?.toLowerCase() === subLc) kinds.add("source");
    if (u) {
      for (const v of u.views) {
        if (v.zeroOut) kinds.add("zero-out");
        if (ds?.type === "TM1CubeView" && v.view && ds.view?.toLowerCase() === v.view.toLowerCase()) kinds.add("source");
      }
      if (u.loopRead) kinds.add("source");
      if (u.loopZero) kinds.add("zero-out");
      else if (u.loopWrite) kinds.add("write");
    }
  }
  if (kinds.size === 0) kinds.add("indeterminate");
  return [...kinds].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Rework the element-filter block in `traceDataFlow`**

Extend the `opts` type with `elementAccess?: AccessKind[]`. Replace the `if (opts?.element)` block's
per-process build with the access-classified + filtered version:

```ts
if (opts?.element) {
  const { dimension, name } = opts.element;
  const key = elementKey(dimension, name);
  const wanted = new Set<AccessKind>(opts.elementAccess ?? ['source', 'write', 'zero-out']);

  // process (orig case) -> { funcNames, subsets(lc) }
  const perProc = new Map<string, { funcNames: Set<string>; subsets: Set<string> }>();
  for (const r of index.byElement.get(key) ?? []) {
    const e = perProc.get(r.sourceName) ?? { funcNames: new Set<string>(), subsets: new Set<string>() };
    if (r.funcName) e.funcNames.add(r.funcName);
    if (r.subset) e.subsets.add(r.subset.toLowerCase());
    perProc.set(r.sourceName, e);
  }

  const dsByProc = new Map<string, DataSourceEntry>();
  for (const d of dsList) dsByProc.set(d.name.toLowerCase(), d);

  let suppressedIndeterminate = 0;
  const processes: Array<{ process: string; funcNames: string[]; access: AccessKind[] }> = [];
  for (const [process, e] of perProc) {
    const usage = index.subsetUsageByProcess.get(process.toLowerCase());
    const access = classifyElementAccess(usage, [...e.subsets], dsByProc.get(process.toLowerCase()));
    if (!access.some((a) => wanted.has(a))) {
      if (access.length === 1 && access[0] === 'indeterminate') suppressedIndeterminate++;
      continue;
    }
    processes.push({ process, funcNames: [...e.funcNames].sort((a, b) => a.localeCompare(b)), access });
  }
  processes.sort((a, b) => a.process.localeCompare(b.process));

  const unresolvedInProcesses = [...index.unresolvedElementRefsBySourceProcess.entries()]
    .filter(([, list]) => list.some((u) => (u.dimension ?? "").toLowerCase() === dimension.toLowerCase()))
    .map(([proc]) => proc).sort((a, b) => a.localeCompare(b));

  result.element = {
    dimension, name, processes,
    ...(unresolvedInProcesses.length ? { unresolvedInProcesses } : {}),
    ...(suppressedIndeterminate ? { suppressedIndeterminate } : {}),
    resolution: "access classified from in-code subset usage (view-assign/zero-out/loop) + datasource; 'indeterminate' means built-but-not-classified, NOT unused; stored view/subset MDX not resolved (Bucket B).",
  };
}
```

> Update the `DataFlowResult.element` type: `processes[]` item → `{ process: string; funcNames:
> string[]; access: AccessKind[] }` (add `via?: MembershipVia[]` ONLY if the Bucket-B branch is
> present); add `suppressedIndeterminate?: number`. Keep `unresolvedInProcesses?`, `resolution`.

- [ ] **Step 5: Run — expect PASS** (`npx vitest run tests/unit/data-flow.test.ts`).

- [ ] **Step 6: Tool input `elementAccess`**

In `src/tools/analysis/trace-data-flow.ts` add (after `dimension`):

```ts
      elementAccess: z
        .array(z.enum(["source", "write", "zero-out", "indeterminate"]))
        .optional()
        .describe("Element roles to include (default source+write+zero-out). Add 'indeterminate' to also list processes that build the subset but whose use we could not classify (NOT proof of no use)."),
```

Pass it through:
`element && dimension ? { element: { dimension, name: element }, ...(elementAccess ? { elementAccess } : {}) } : undefined`
(destructure `elementAccess` in the handler args). Append a description sentence:

```ts
      "Each touching process is tagged access=source|write|zero-out|indeterminate so a zero-out is not mistaken for a read-source.",
```

- [ ] **Step 7: Schema (same task)**

In `DataFlowResultSchema.element` (`items.ts`): add `access` to the `processes` item and add
`suppressedIndeterminate`:

```ts
      processes: z.array(z.object({
        process: z.string(),
        funcNames: z.array(z.string()),
        access: z.array(z.enum(["source", "write", "zero-out", "indeterminate"])),
      })),
      // ... existing element fields (unresolvedInProcesses, resolution, etc.) ...
      suppressedIndeterminate: z.number().int().optional(),
```

(If the Bucket-B branch added `via`/`computedInProcesses`, keep them; this task only adds `access` +
`suppressedIndeterminate`.)

- [ ] **Step 8: Verify + README + commit**

Run: `npm run verify` → green. **If `lint:output-schema-budget` fails (was 96.6%), STOP and report the
byte count — do not raise the cap.** Then `npm run tools:update-readme`.

```bash
git add src/lib/callgraph/dataFlow.ts src/tools/analysis/trace-data-flow.ts src/tools/schemas/items.ts tests/unit/data-flow.test.ts README.md
git commit -m "feat(trace-data-flow): classify element access (source/write/zero-out/indeterminate) + elementAccess filter"
```

---

### Task 4: Live validation + docs

**Files:** Modify `CHANGELOG.md` (`[Unreleased]`); live probe (controller-driven).

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Added` (or `### Changed`):

```markdown
- `tm1_trace_data_flow` element tracing now classifies each touching process by how it uses the
  element's subset: `source` (read/datasource), `write`, `zero-out` (e.g. `ViewZeroOut`), or
  `indeterminate` (built but not classifiable — NOT a claim of non-use). New `elementAccess` input
  filters roles (default source+write+zero-out); suppressed `indeterminate` processes are counted.
```

- [ ] **Step 2: Live probe (tm1-test)**

```
tm1_upsert_process(name="zAccTest", mode="create",
  prolog="SubsetCreate('sAcc','Currency',1);\nSubsetElementInsert('Currency','sAcc','USD',1);\nViewSubsetAssign('<realCube>','vAcc','Currency','sAcc');\nViewZeroOut('<realCube>','vAcc');")
tm1_trace_data_flow(cubeName="<realCube>", element="USD", dimension="Currency", elementAccess=["source","write","zero-out"])
→ expect process zAccTest with access ["zero-out"]
tm1_trace_data_flow(cubeName="<realCube>", element="USD", dimension="Currency")   # default includes zero-out
→ zAccTest still present
tm1_delete_process(processName="zAccTest", confirm="zAccTest")
```
Pick `<realCube>` that contains the Currency dimension (`tm1_list_cubes` / `list_dimensions`). Also
verify a build-only subset (no view/loop) lands in `suppressedIndeterminate` under the default filter
and shows `access:["indeterminate"]` only when `elementAccess` includes it.

- [ ] **Step 3: Commit** `git commit -m "docs(trace-data-flow): changelog for element access classification"`

---

## Notes for the executor

- **No new REST.** Datasource facts come from `dsList` already passed to `traceDataFlow`.
- **Loose loop heuristic** (Task 2): process-wide cell-read/write presence attributed to iterated
  subsets. Accepted looseness (spec). Prefer `indeterminate` over a confident wrong tag if you tighten.
- **`indeterminate` ≠ unused** — the word "unused" must appear nowhere in output; the `resolution`
  string and `suppressedIndeterminate` count carry the honest message.
- **Bucket B interaction:** if this lands on a branch that also has Bucket B (`via`/datasource
  membership), merge — a datasource hit is `source`; keep both `access` and `via`. If Bucket B is not
  present, ignore those fields.
- **Budget:** output-schema at 96.6%; the `access` array + `suppressedIndeterminate` are small but
  watch the gate.

## Self-review

- **Spec coverage:** access taxonomy (source/write/zero-out/indeterminate) → Task 3 `AccessKind` +
  `classifyElementAccess`. Handle-chain subset→view→zero-out/datasource → Task 2 (`extractSubsetUsage`)
  + Task 3 datasource join. Index-loop detection (decision 3) → Task 2 loop heuristic. Separate
  `zero-out` (decision 2) → literal-0 detection. Default `source+write+zero-out`, indeterminate opt-in
  + count (decision 1) → Task 3 filter + `suppressedIndeterminate`. Model B (decision 4) →
  `subsetUsageByProcess`. Honest `indeterminate`/no-"unused" → `resolution` string + count. Element→
  subset link → Task 1 `TmReference.subset`.
- **Placeholders:** none.
- **Type consistency:** `AccessKind`, `SubsetUsage`/`ViewUsage`, `extractSubsetUsage`,
  `subsetUsageByProcess`, `TmReference.subset`, `SUBSET_ARG_IDX`, `classifyElementAccess`,
  `elementAccess`, `suppressedIndeterminate` — same names across tasks.
