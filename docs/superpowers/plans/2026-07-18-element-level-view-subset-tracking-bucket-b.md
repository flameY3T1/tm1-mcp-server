# Element-Level View/Subset Tracking — Implementation Plan (Phase 2, Bucket B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Phase 1 (Bucket A) AND Phase 1.5 (usage classification), both merged (`b3eeb8b`).** Reuses `elementKey`, `ReferenceIndex.byElement`, `DataFlowResult.element`, the `element`/`dimension`/`elementAccess` tool filter, and the Phase-1.5 `access: AccessKind[]` + `classifyElementAccess` + `suppressedIndeterminate`. Task 3 is RECONCILED with the post-1.5 element shape (see its note); Tasks 1-2 are independent pure modules unaffected by 1.5.

**Goal:** Resolve element membership through **server-side** view/subset objects a process uses as
its datasource — so "which processes touch element X of dimension D" also finds processes that
read X through a stored/native view or a stored subset, not only in-code subset builds.

**Architecture:** Two pieces. (1) A **pure** MDX member extractor: given an MDX string, pull the
literally-named `[Dim].[…].[Element]` member references and detect *computed selectors*
(`TM1FILTERBYLEVEL`, `DESCENDANTS`, `TM1SUBSETALL`, …) that scope elements without naming them.
(2) An **I/O adapter** that, for each process datasource that is a `TM1CubeView` or
`TM1DimensionSubset`, fetches the view/subset definition and turns it into element→process
membership: native-view titles give an exact `selectedElement`; static subsets give an exact
`elements` list; MDX views / MDX subset expressions go through the extractor. Computed selectors
are **flagged** (the Bucket C boundary), never treated as "no elements." The result is merged into
`traceDataFlow`'s element filter, tagged by `via`.

**Tech Stack:** TypeScript (strict), vitest. Pure extractor in `src/lib/callgraph/`; I/O adapter
in `src/lib/callgraph/`; existing services `tm1Client.views.getDefinition` /
`tm1Client.subsets.get`; MCP handler `src/tools/analysis/trace-data-flow.ts`; schema
`src/tools/schemas/items.ts`.

## Global Constraints

- **Service composition:** this plan adds **no new REST method** — it consumes the existing
  `ViewService.getDefinition` and `SubsetService.get`. If a bulk variant is later wanted, it goes
  in the service (`lint:no-flat-api`), but not here.
- **Strict output schemas:** every new `DataFlowResult.element` field lands in
  `DataFlowResultSchema` (`src/tools/schemas/items.ts`) in the **same task**.
- **Tool annotations:** no new tool; `tm1_trace_data_flow` stays read-only.
- **Resilience:** a fetch failure for ONE view/subset must not blank the whole membership index.
  Re-throw genuine outages via `rethrowIfSystemic` (`src/tm1-client/services/fallback.js`); skip
  per-object non-systemic failures and record them, so a partial index is never silently treated
  as complete.
- **Commits:** Conventional Commits; one logical change per commit; synthetic names only.
- After the tool description changes: `npm run tools:update-readme`.

## Verified current-state facts (do not re-derive)

- `ViewService.getDefinition(cubeName, viewName, isPrivate?): Promise<ViewDefinition>` — no
  execution, MDX or native. `src/tm1-client/services/view-service.ts:117-243`.
- `SubsetService.get(dimensionName, hierarchyName, subsetName, isPrivate=false): Promise<Subset>`
  — returns `{ name, dimensionName, hierarchyName, private, expression?, elements: string[],
  alias? }`. Static subset → `elements` filled; MDX subset → `expression` filled.
  `src/tm1-client/services/subset-service.ts:55-79`.
- Types (`src/types.ts`):
  - `ViewDefinition { cubeName; viewName; private; type: "MDX"|"Native"; mdx?; native? }` — `:238`.
  - `NativeViewDefinition { titles: ViewTitleRef[]; columns: ViewAxisSubsetRef[]; rows: ViewAxisSubsetRef[] }` — `:201`.
  - `ViewAxisSubsetRef { dimensionName?; hierarchyName?; subsetName?; expression? }` — `:190`.
  - `ViewTitleRef extends ViewAxisSubsetRef { selectedElement? }` — `:197`.
  - `Subset { name; dimensionName; hierarchyName; private; expression?; elements: string[]; alias? }` — `:489`.
- Services are on the client: `tm1Client.views` / `tm1Client.subsets` — `src/tm1-client.ts:43-63`.
- Datasource list shape (from Phase-1 facts): `listDataSources()` → `Array<{ name; type;
  sourceName?; view?; subset? }>`. For `TM1CubeView`: `sourceName` = cube, `view` = view name.
  For `TM1DimensionSubset`: `subset` = subset name, `sourceName` = `dataSourceNameForServer`
  (the dimension — **verify live**, Task 4). `src/tm1-client/services/process-service.ts:502-527`.
- Phase-1 additions this plan builds on: `elementKey(dim, el)`,
  `ReferenceIndex.byElement`, `DataFlowResult.element { dimension; name; processes: {process;
  funcNames}[]; unresolvedInProcesses? }`, `traceDataFlow(index, dsList, cubeName, direction,
  opts?)`, tool inputs `element`/`dimension`.

---

### Task 1: Pure MDX member extractor

**Files:**
- Create: `src/lib/callgraph/mdxMembers.ts`
- Test: `tests/unit/mdx-members.test.ts`

**Interfaces:**
- Produces:
  - `interface MdxMemberRef { dimension: string; element: string }`
  - `interface MdxExtractResult { members: MdxMemberRef[]; computedSelectors: string[] }`
  - `function extractMdxMemberRefs(mdx: string): MdxExtractResult`
  - `const MDX_COMPUTED_FUNCS: ReadonlySet<string>` (exported for reuse/testing)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/mdx-members.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractMdxMemberRefs } from "../../src/lib/callgraph/mdxMembers.js";

describe("extractMdxMemberRefs", () => {
  it("extracts a two-part [Dim].[Element] member", () => {
    const r = extractMdxMemberRefs("{ [Datenquellen].[SuDatenquellen_C] }");
    expect(r.members).toEqual([{ dimension: "Datenquellen", element: "SuDatenquellen_C" }]);
    expect(r.computedSelectors).toEqual([]);
  });

  it("takes dimension from first part and element from last part of a 3-part ref", () => {
    const r = extractMdxMemberRefs("[Kunde].[Kunde].[K100]");
    expect(r.members).toEqual([{ dimension: "Kunde", element: "K100" }]);
  });

  it("flags computed selectors and does NOT invent members for them", () => {
    const r = extractMdxMemberRefs("{TM1FILTERBYLEVEL(TM1SUBSETALL([Datenquellen]),0)}");
    expect(r.members).toEqual([]); // [Datenquellen] alone is a dimension ref, not a member
    expect(r.computedSelectors.sort()).toEqual(["TM1FILTERBYLEVEL", "TM1SUBSETALL"]);
  });

  it("captures explicit members even alongside a computed selector", () => {
    const r = extractMdxMemberRefs("{ DESCENDANTS([Zeit].[2026]) , [Datenquellen].[SuDatenquellen_C] }");
    expect(r.members).toEqual([
      { dimension: "Zeit", element: "2026" },
      { dimension: "Datenquellen", element: "SuDatenquellen_C" },
    ]);
    expect(r.computedSelectors).toEqual(["DESCENDANTS"]);
  });

  it("dedupes repeated members", () => {
    const r = extractMdxMemberRefs("[D].[E] + [D].[E]");
    expect(r.members).toEqual([{ dimension: "D", element: "E" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/mdx-members.test.ts`
Expected: FAIL — module `mdxMembers.ts` does not exist.

- [ ] **Step 3: Implement the extractor**

Create `src/lib/callgraph/mdxMembers.ts`:

```ts
// Pure, scoped literal extraction of member references from a TM1 MDX string.
// NOT a full MDX parser: it pulls bracketed member paths ([Dim].[…].[Element])
// and flags computed set functions (which scope elements WITHOUT naming them,
// e.g. all leaves of a dimension) so callers can report them as unresolved
// rather than imply "no elements".

export interface MdxMemberRef {
  dimension: string;
  element: string;
}

export interface MdxExtractResult {
  members: MdxMemberRef[];
  computedSelectors: string[];
}

/** MDX set functions that compute membership without naming elements (Bucket C boundary). */
export const MDX_COMPUTED_FUNCS: ReadonlySet<string> = new Set([
  "TM1FILTERBYLEVEL",
  "TM1FILTERBYPATTERN",
  "TM1SUBSETALL",
  "TM1DRILLDOWNMEMBER",
  "DESCENDANTS",
  "ANCESTORS",
  "ANCESTOR",
  "CHILDREN",
  "MEMBERS",
  "HIERARCHIZE",
  "FILTER",
  "TOPCOUNT",
  "BOTTOMCOUNT",
  "ORDER",
  "EXCEPT",
  "GENERATE",
]);

// One bracketed segment: [ ... ] where ]] is an escaped ]. A chain of ≥2 segments
// separated by dots is a member path; a lone segment is a dimension/hier ref.
const MEMBER_PATH_RE = /(\[(?:[^\]]|\]\])*\])(?:\s*\.\s*(\[(?:[^\]]|\]\])*\]))+/g;
const SEGMENT_RE = /\[((?:[^\]]|\]\])*)\]/g;
const FUNC_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

function unbracket(seg: string): string {
  // strip the outer [ ], unescape ]] -> ]
  return seg.slice(1, -1).replace(/\]\]/g, "]");
}

export function extractMdxMemberRefs(mdx: string): MdxExtractResult {
  const members: MdxMemberRef[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  MEMBER_PATH_RE.lastIndex = 0;
  while ((m = MEMBER_PATH_RE.exec(mdx)) !== null) {
    const segs = m[0].match(SEGMENT_RE);
    if (!segs || segs.length < 2) continue;
    const dimension = unbracket(segs[0]!);
    const element = unbracket(segs[segs.length - 1]!);
    const key = `${dimension.toLowerCase()} ${element.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      members.push({ dimension, element });
    }
  }

  const computed = new Set<string>();
  let f: RegExpExecArray | null;
  FUNC_RE.lastIndex = 0;
  while ((f = FUNC_RE.exec(mdx)) !== null) {
    const name = f[1]!.toUpperCase();
    if (MDX_COMPUTED_FUNCS.has(name)) computed.add(name);
  }

  return { members, computedSelectors: [...computed].sort((a, b) => a.localeCompare(b)) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/mdx-members.test.ts`
Expected: PASS (all 5).

> If the 3-part test fails because a member path like `[Kunde].[Kunde].[K100]` also matched a
> two-segment prefix, confirm `MEMBER_PATH_RE` greedily consumes the full dotted chain (the `(?:…)+`
> quantifier does). The regex captures the longest chain; `segs.length` is 3 → dimension seg[0],
> element seg[2]. Correct.

- [ ] **Step 5: Commit**

```bash
git add src/lib/callgraph/mdxMembers.ts tests/unit/mdx-members.test.ts
git commit -m "feat(callgraph): pure MDX member extractor + computed-selector detection"
```

---

### Task 2: Datasource membership adapter (I/O)

**Files:**
- Create: `src/lib/callgraph/datasourceMembership.ts`
- Test: `tests/unit/datasource-membership.test.ts`

**Interfaces:**
- Consumes: `extractMdxMemberRefs` (Task 1); `elementKey` (Phase 1); `ViewDefinition`, `Subset`
  (`src/types.ts`); `DataSourceEntry` (`dataFlow.ts`); `rethrowIfSystemic`
  (`src/tm1-client/services/fallback.js`).
- Produces:
  - `type MembershipVia = 'view-mdx' | 'view-native-title' | 'view-native-expr' | 'subset-static' | 'subset-mdx'`
  - `interface DatasourceMembership { byElement: Map<string, Array<{ process: string; via: MembershipVia }>>; computedByProcess: Map<string, Set<string>>; fetchErrors: Array<{ process: string; object: string; message: string }> }`
  - `interface MembershipDeps { getViewDefinition(cube: string, view: string): Promise<ViewDefinition>; getSubset(dimension: string, hierarchy: string, subset: string): Promise<Subset> }`
  - `async function buildDatasourceMembership(deps: MembershipDeps, dsList: DataSourceEntry[]): Promise<DatasourceMembership>`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/datasource-membership.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDatasourceMembership } from "../../src/lib/callgraph/datasourceMembership.js";
import { elementKey } from "../../src/lib/callgraph/referenceIndex.js";

const noView = async () => { throw new Error("no view"); };
const noSubset = async () => { throw new Error("no subset"); };

describe("buildDatasourceMembership", () => {
  it("resolves a static subset datasource to exact elements", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: noView as never,
        getSubset: async (dim: string, _h: string, sub: string) => ({
          name: sub, dimensionName: dim, hierarchyName: dim, private: false,
          expression: undefined, elements: ["SuDatenquellen_C", "SuDatenquellen_D"], alias: undefined,
        }),
      },
      [{ name: "P", type: "TM1DimensionSubset", sourceName: "Datenquellen", subset: "sMy" }],
    );
    expect(m.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"))).toEqual([
      { process: "P", via: "subset-static" },
    ]);
  });

  it("resolves an MDX view datasource to literal members + flags computed selectors", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "MDX" as const,
          mdx: "{ TM1FILTERBYLEVEL(TM1SUBSETALL([Zeit]),0) } * { [Datenquellen].[SuDatenquellen_C] }",
        }),
        getSubset: noSubset as never,
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "ZusaetzlicheFahrten", view: "vMy" }],
    );
    expect(m.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"))).toEqual([
      { process: "P", via: "view-mdx" },
    ]);
    expect([...(m.computedByProcess.get("P") ?? [])].sort()).toEqual(["TM1FILTERBYLEVEL", "TM1SUBSETALL"]);
  });

  it("resolves a native view title's selectedElement exactly", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: {
            titles: [{ dimensionName: "Szenario", selectedElement: "Ist" }],
            columns: [], rows: [],
          },
        }),
        getSubset: noSubset as never,
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vT" }],
    );
    expect(m.byElement.get(elementKey("Szenario", "Ist"))).toEqual([
      { process: "P", via: "view-native-title" },
    ]);
  });

  it("records a per-object fetch error without throwing", async () => {
    const m = await buildDatasourceMembership(
      { getViewDefinition: async () => { throw new Error("boom"); }, getSubset: noSubset as never },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vX" }],
    );
    expect(m.byElement.size).toBe(0);
    expect(m.fetchErrors).toEqual([{ process: "P", object: "view C/vX", message: "boom" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/datasource-membership.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the adapter**

Create `src/lib/callgraph/datasourceMembership.ts`:

```ts
import type { ViewDefinition, Subset } from "../../types.js";
import type { DataSourceEntry } from "./dataFlow.js";
import { elementKey } from "./referenceIndex.js";
import { extractMdxMemberRefs } from "./mdxMembers.js";
import { rethrowIfSystemic } from "../../tm1-client/services/fallback.js";

export type MembershipVia =
  | "view-mdx"
  | "view-native-title"
  | "view-native-expr"
  | "subset-static"
  | "subset-mdx";

export interface DatasourceMembership {
  /** elementKey(dim, element) → processes that reach it through a datasource object. */
  byElement: Map<string, Array<{ process: string; via: MembershipVia }>>;
  /** process → computed MDX selectors encountered (Bucket C boundary; element identity not literal). */
  computedByProcess: Map<string, Set<string>>;
  /** per-object fetch failures (non-systemic); systemic errors are re-thrown. */
  fetchErrors: Array<{ process: string; object: string; message: string }>;
}

export interface MembershipDeps {
  getViewDefinition(cube: string, view: string): Promise<ViewDefinition>;
  getSubset(dimension: string, hierarchy: string, subset: string): Promise<Subset>;
}

export async function buildDatasourceMembership(
  deps: MembershipDeps,
  dsList: DataSourceEntry[],
): Promise<DatasourceMembership> {
  const byElement = new Map<string, Array<{ process: string; via: MembershipVia }>>();
  const computedByProcess = new Map<string, Set<string>>();
  const fetchErrors: DatasourceMembership["fetchErrors"] = [];

  const addMember = (process: string, dim: string, el: string, via: MembershipVia) => {
    const k = elementKey(dim, el);
    const arr = byElement.get(k) ?? [];
    if (!arr.some((e) => e.process === process && e.via === via)) arr.push({ process, via });
    byElement.set(k, arr);
  };
  const addComputed = (process: string, names: string[]) => {
    if (names.length === 0) return;
    const set = computedByProcess.get(process) ?? new Set<string>();
    for (const n of names) set.add(n);
    computedByProcess.set(process, set);
  };
  const addMdx = (process: string, mdx: string, via: MembershipVia) => {
    const { members, computedSelectors } = extractMdxMemberRefs(mdx);
    for (const ref of members) addMember(process, ref.dimension, ref.element, via);
    addComputed(process, computedSelectors);
  };
  const applySubset = (process: string, sub: Subset) => {
    if (sub.elements.length > 0) {
      for (const el of sub.elements) addMember(process, sub.dimensionName, el, "subset-static");
    } else if (sub.expression) {
      addMdx(process, sub.expression, "subset-mdx");
    }
  };

  for (const ds of dsList) {
    try {
      if (ds.type === "TM1CubeView" && ds.sourceName && ds.view) {
        const def = await deps.getViewDefinition(ds.sourceName, ds.view);
        if (def.type === "MDX" && def.mdx) {
          addMdx(ds.name, def.mdx, "view-mdx");
        } else if (def.type === "Native" && def.native) {
          const axes = [...def.native.titles, ...def.native.columns, ...def.native.rows];
          for (const ax of axes) {
            const selected = (ax as { selectedElement?: string }).selectedElement;
            if (selected && ax.dimensionName) {
              addMember(ds.name, ax.dimensionName, selected, "view-native-title");
            }
            if (ax.expression) {
              addMdx(ds.name, ax.expression, "view-native-expr");
            } else if (ax.subsetName && ax.dimensionName) {
              const sub = await deps.getSubset(ax.dimensionName, ax.hierarchyName ?? ax.dimensionName, ax.subsetName);
              applySubset(ds.name, sub);
            }
          }
        }
      } else if (ds.type === "TM1DimensionSubset" && ds.subset && ds.sourceName) {
        const dim = ds.sourceName; // dataSourceNameForServer — the dimension (verify live, Task 4)
        const sub = await deps.getSubset(dim, dim, ds.subset);
        applySubset(ds.name, sub);
      }
    } catch (e) {
      rethrowIfSystemic(e);
      const object =
        ds.type === "TM1CubeView"
          ? `view ${ds.sourceName}/${ds.view}`
          : `subset ${ds.sourceName}/${ds.subset}`;
      fetchErrors.push({ process: ds.name, object, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return { byElement, computedByProcess, fetchErrors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/datasource-membership.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Full verify + commit**

Run: `npm run verify`
Expected: green.

```bash
git add src/lib/callgraph/datasourceMembership.ts tests/unit/datasource-membership.test.ts
git commit -m "feat(callgraph): datasource membership adapter (view/subset defs → element refs, computed flagged)"
```

---

### Task 3: Merge datasource membership into the element filter + tool wiring

**Files:**
- Modify: `src/lib/callgraph/dataFlow.ts` (`traceDataFlow` opts + element merge; `DataFlowResult.element`)
- Modify: `src/tools/analysis/trace-data-flow.ts` (build membership when element filter set; new opt-out input)
- Modify: `src/tools/schemas/items.ts` (`DataFlowResultSchema.element`)
- Test: `tests/unit/data-flow.test.ts` (extend)

**RECONCILED with Phase 1.5 (merged):** the current `element.processes[]` item is
`{ process; funcNames; access: AccessKind[] }` and `traceDataFlow` opts is
`{ element?; elementAccess? }` with a `classifyElementAccess` helper + `suppressedIndeterminate`.
Read the CURRENT element block in `dataFlow.ts` (`if (opts?.element)`, ~`:259-303`) before editing —
Bucket B is ADDITIVE on top of it, not a replacement of a pre-1.5 shape. A stored view/subset
datasource hit IS a read, so a Bucket-B process gets `access` including `'source'` PLUS a `via` tag.

**Interfaces:**
- Consumes: `DatasourceMembership`, `MembershipVia`, `buildDatasourceMembership` (Task 2); the
  Phase-1.5 `element` block + `AccessKind`/`classifyElementAccess`.
- Produces:
  - `traceDataFlow(..., opts?)` — `opts` gains `datasourceMembership?: DatasourceMembership`
    (keep the existing `element?` and `elementAccess?`).
  - `DataFlowResult.element.processes[]` items gain optional `via?: MembershipVia[]` (kept alongside
    the existing `access`/`funcNames`).
  - `DataFlowResult.element` gains optional `computedInProcesses?: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/data-flow.test.ts`:

```ts
import { buildDatasourceMembership } from "../../src/lib/callgraph/datasourceMembership.js";

describe("traceDataFlow — element filter incl. datasource membership", () => {
  it("merges a static-subset datasource reader into element.processes with a via tag", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "Reader", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const membership = await buildDatasourceMembership(
      {
        getViewDefinition: async () => { throw new Error("n/a"); },
        getSubset: async (dim: string, _h: string, sub: string) => ({
          name: sub, dimensionName: dim, hierarchyName: dim, private: false,
          expression: undefined, elements: ["SuDatenquellen_C"], alias: undefined,
        }),
      },
      [{ name: "Reader", type: "TM1DimensionSubset", sourceName: "Datenquellen", subset: "sMy" }],
    );
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Datenquellen", name: "SuDatenquellen_C" },
      datasourceMembership: membership,
    });
    // A stored-subset datasource hit is a read → access ['source'] PLUS a via tag.
    expect(flow.element!.processes).toEqual([
      { process: "Reader", funcNames: [], access: ["source"], via: ["subset-static"] },
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: FAIL — `opts.datasourceMembership` unknown; `via` not emitted.

- [ ] **Step 3: Extend types + merge logic in `traceDataFlow`**

In `dataFlow.ts`, import the membership types at the top:

```ts
import type { DatasourceMembership, MembershipVia } from "./datasourceMembership.js";
```

Add `via?` to the EXISTING `element.processes` item type and add `computedInProcesses` in
`DataFlowResult` (the item already has `process`/`funcNames`/`access` from Phase 1.5 — keep those):

```ts
    processes: Array<{ process: string; funcNames: string[]; access: AccessKind[]; via?: MembershipVia[] }>;
    // ...existing unresolvedInProcesses?, suppressedIndeterminate?, resolution ...
    /** Processes whose datasource scopes elements via a computed selector (element identity not literally verifiable). */
    computedInProcesses?: string[];
```

Extend the EXISTING `opts` param with `datasourceMembership` (keep `element` and `elementAccess`):

```ts
  opts?: { element?: { dimension: string; name: string }; elementAccess?: AccessKind[]; datasourceMembership?: DatasourceMembership },
```

Rework the CURRENT element-filter block (Phase 1.5) so it ALSO folds in datasource-membership hits.
The in-code path (`perProc` from `index.byElement`, `classifyElementAccess`, `wanted`/`elementAccess`
filter, `suppressedIndeterminate`) stays; add a `dsVia` map and a `'source'` access + `via` tag for
Bucket-B hits, and union the process sets:

```ts
if (opts?.element) {
  const { dimension, name } = opts.element;
  const key = elementKey(dimension, name);
  const wanted = new Set<AccessKind>(opts.elementAccess ?? ["source", "write", "zero-out"]);

  // in-code (Phase 1/1.5): funcNames + subsets per process
  const perProc = new Map<string, { funcNames: Set<string>; subsets: Set<string> }>();
  for (const r of index.byElement.get(key) ?? []) {
    const e = perProc.get(r.sourceName) ?? { funcNames: new Set<string>(), subsets: new Set<string>() };
    if (r.funcName) e.funcNames.add(r.funcName);
    if (r.subset) e.subsets.add(r.subset.toLowerCase());
    perProc.set(r.sourceName, e);
  }

  // Bucket B: stored view/subset datasource membership → via tags per process (a datasource IS a read).
  const dsVia = new Map<string, Set<MembershipVia>>();
  for (const hit of opts.datasourceMembership?.byElement.get(key) ?? []) {
    const set = dsVia.get(hit.process) ?? new Set<MembershipVia>();
    set.add(hit.via);
    dsVia.set(hit.process, set);
  }

  const dsByProc = new Map<string, DataSourceEntry>();
  for (const d of dsList) dsByProc.set(d.name.toLowerCase(), d);

  const allProcs = new Set<string>([...perProc.keys(), ...dsVia.keys()]);
  let suppressedIndeterminate = 0;
  const processes: Array<{ process: string; funcNames: string[]; access: AccessKind[]; via?: MembershipVia[] }> = [];
  for (const process of allProcs) {
    const e = perProc.get(process);
    const usage = index.subsetUsageByProcess.get(process.toLowerCase());
    const accessSet = new Set<AccessKind>(
      e ? classifyElementAccess(usage, [...e.subsets], dsByProc.get(process.toLowerCase()), dimension) : [],
    );
    const via = [...(dsVia.get(process) ?? [])].sort((a, b) => a.localeCompare(b));
    if (via.length) accessSet.add("source");           // stored view/subset datasource = read
    if (accessSet.size === 0) accessSet.add("indeterminate");
    const access = [...accessSet].sort((a, b) => a.localeCompare(b));
    if (!access.some((a) => wanted.has(a))) {
      if (access.length === 1 && access[0] === "indeterminate") suppressedIndeterminate++;
      continue;
    }
    const funcNames = [...(e?.funcNames ?? [])].sort((a, b) => a.localeCompare(b));
    processes.push(via.length ? { process, funcNames, access, via } : { process, funcNames, access });
  }
  processes.sort((a, b) => a.process.localeCompare(b.process));

  const unresolvedInProcesses = [...index.unresolvedElementRefsBySourceProcess.entries()]
    .filter(([, list]) => list.some((u) => (u.dimension ?? "").toLowerCase() === dimension.toLowerCase()))
    .map(([proc]) => proc)
    .sort((a, b) => a.localeCompare(b));

  const computedInProcesses = [...(opts.datasourceMembership?.computedByProcess.keys() ?? [])]
    .sort((a, b) => a.localeCompare(b));

  result.element = {
    dimension,
    name,
    processes,
    ...(unresolvedInProcesses.length ? { unresolvedInProcesses } : {}),
    ...(suppressedIndeterminate ? { suppressedIndeterminate } : {}),
    ...(computedInProcesses.length ? { computedInProcesses } : {}),
    resolution:
      "access from in-code subset usage (view-assign/zero-out/loop) + datasource; stored view/subset datasources resolved (native-title/static exact, MDX by literal member); computed selectors (TM1FILTERBY*/DESCENDANTS/…) flagged in computedInProcesses, not resolved; 'indeterminate' = built but not classifiable, not evidence the element goes untouched.",
  };
}
```

> `computedInProcesses` is dimension-agnostic (any computed selector in the process's datasource) —
> a Bucket-C honesty flag, acceptable as-is. Note the `resolution` string is UPDATED: stored
> view/subset datasources are now resolved, so it no longer says "Bucket B pending".

- [ ] **Step 4: Run the dataFlow test**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the tool handler**

In `src/tools/analysis/trace-data-flow.ts`, import the builder:

```ts
import { buildDatasourceMembership } from "../../lib/callgraph/datasourceMembership.js";
```

Add an opt-out input (after `dimension`):

```ts
      resolveDatasourceMembership: z
        .boolean()
        .optional()
        .default(true)
        .describe("When tracing an element, also resolve server-side view/subset datasources (extra fetches). Default true; set false to skip for speed."),
```

Adjust the handler destructure to include `resolveDatasourceMembership`, and build membership only
when an element filter is active and resolution is on, BEFORE calling `traceDataFlow`:

```ts
      let datasourceMembership;
      if (element && dimension && resolveDatasourceMembership) {
        datasourceMembership = await buildDatasourceMembership(
          {
            getViewDefinition: (cube, view) => tm1Client.views.getDefinition(cube, view),
            getSubset: (dim, hier, sub) => tm1Client.subsets.get(dim, hier, sub),
          },
          dsList,
        );
      }

      const flow = traceDataFlow(index, dsList, cubeName, direction,
        element && dimension
          ? { element: { dimension, name: element }, ...(elementAccess ? { elementAccess } : {}), datasourceMembership }
          : undefined);
```

> Keep the existing `elementAccess` passthrough (Phase 1.5) — do NOT drop it. `datasourceMembership`
> is `undefined` when the opt-out flag is off; `traceDataFlow` handles that (no Bucket-B hits).

Append a sentence to the tool description `.join(" ")` array:

```ts
      "Element tracing also resolves stored view/subset datasources (native-view titles + static subsets exactly; MDX views/subsets by literal member; computed selectors are flagged, not resolved).",
```

- [ ] **Step 6: Extend `DataFlowResultSchema.element` (same task)**

In `src/tools/schemas/items.ts`, the `element` block already has `access` + `suppressedIndeterminate`
(Phase 1.5). ADD `via` to the processes item and `computedInProcesses` at the element level — do not
remove the existing fields:

```ts
  element: z
    .object({
      dimension: z.string(),
      name: z.string(),
      processes: z.array(
        z.object({
          process: z.string(),
          funcNames: z.array(z.string()),
          access: z.array(z.enum(["source", "write", "zero-out", "indeterminate"])),   // existing (1.5)
          via: z.array(z.string()).optional(),                                          // NEW (Bucket B)
        }),
      ),
      unresolvedInProcesses: z.array(z.string()).optional(),        // existing
      suppressedIndeterminate: z.number().int().optional(),         // existing (1.5)
      computedInProcesses: z.array(z.string()).optional(),          // NEW (Bucket B)
      resolution: z.string(),                                       // existing
    })
    .optional(),
```

> **output-schema-budget is at 96.9% of the 82000-byte cap.** `via` + `computedInProcesses` add a
> little. If `lint:output-schema-budget` FAILS after this, STOP and report the byte count — do not
> raise the cap without a decision.

- [ ] **Step 7: Run tests + full verify**

Run: `npx vitest run tests/unit/data-flow.test.ts`
Expected: PASS.
Run: `npm run verify`
Expected: green. Update the `output-schema-map` `tm1_trace_data_flow` fixture if it pins the
`element` shape.

- [ ] **Step 8: Regenerate README + commit**

Run: `npm run tools:update-readme`

```bash
git add src/lib/callgraph/dataFlow.ts src/tools/analysis/trace-data-flow.ts src/tools/schemas/items.ts tests/unit/data-flow.test.ts README.md
git commit -m "feat(trace-data-flow): resolve element membership through stored view/subset datasources (Bucket B)"
```

---

### Task 4: Live validation + docs

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- (Live probe — controller-driven)

**Interfaces:** none.

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- `tm1_trace_data_flow` element tracing now resolves **server-side** view/subset datasources:
  native-view title members and static subsets are matched exactly; MDX views and MDX subset
  expressions are matched by literal member reference; computed selectors (`TM1FILTERBYLEVEL`,
  `DESCENDANTS`, `TM1SUBSETALL`, …) are reported in `computedInProcesses` as unresolved — the
  element may be in scope but is not literally named. Each match carries a `via` tag. Set
  `resolveDatasourceMembership=false` to skip the extra fetches.
```

- [ ] **Step 2: Live probe (against tm1-test)**

First confirm the subset-datasource dimension mapping (the `TM1DimensionSubset` `sourceName`):

```
tm1_list_processes  → pick a process whose datasource is a TM1CubeView or TM1DimensionSubset
tm1_get_process_datasource(processName=…)  → note view/subset + dimension
tm1_trace_data_flow(cubeName=<cube>, direction="both", element=<known element in that view/subset>, dimension=<its dimension>)
→ expect flow.element.processes to contain { process: <that process>, via: [ "subset-static" | "view-mdx" | "view-native-title" | … ] }
→ if the view/subset uses TM1FILTERBYLEVEL/DESCENDANTS, expect the process in flow.element.computedInProcesses
```

Verify the `TM1DimensionSubset` → dimension assumption (Task 2: `ds.sourceName = dimension`,
`hierarchy = dimension`): if a subset-datasource process yields no membership and no fetchError,
the dimension/hierarchy mapping is wrong — inspect the raw `DataSource` via
`tm1_get_process_datasource` and adjust `datasourceMembership.ts`, then re-run.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(trace-data-flow): changelog for Bucket B (server-side view/subset membership)"
```

---

## Notes for the executor

- **Depends on Phase 1 (Bucket A) being merged.** Reuses `elementKey`, `byElement`,
  `DataFlowResult.element`, tool `element`/`dimension` inputs.
- **No new REST.** Uses existing `views.getDefinition` + `subsets.get`. Fetches are per datasource
  object; add a fetch cache keyed by cube/view and dim/hier/subset if live shows the same object
  reused across many processes and latency matters.
- **`TM1DimensionSubset` dimension/hierarchy mapping is an assumption** (`ds.sourceName` = dimension,
  hierarchy = dimension). Verified only at Task 4 Step 2. If wrong, that is the one place to fix.
- **Computed selectors = Bucket C boundary.** They are FLAGGED (`computedInProcesses`), never
  resolved. Fully resolving them (evaluating the subset/view against the live server to enumerate
  members) is Bucket C — a separate future spec, deliberately not attempted here.
- **`via` taxonomy** distinguishes exact (`view-native-title`, `subset-static`) from
  literal-matched-MDX (`view-mdx`, `view-native-expr`, `subset-mdx`) origins, so a reader can weigh
  confidence.

## Self-review

- **Spec coverage (Bucket B section of the design spec):** stored view MDX + static/MDX subset →
  Tasks 1-2; scoped literal match, no AST parser → Task 1 (`extractMdxMemberRefs`); bounded fetch
  via datasource-referenced objects only → Task 2 (iterates `dsList`, not all server views);
  honest flagging of computed membership → `computedInProcesses` (Task 3) + `MDX_COMPUTED_FUNCS`
  (Task 1). Merge into the element filter → Task 3. Bucket C stays deferred + flagged.
- **Placeholders:** none — every code step shows the code.
- **Type consistency:** `MdxMemberRef`/`MdxExtractResult`/`extractMdxMemberRefs`/`MDX_COMPUTED_FUNCS`
  (Task 1); `MembershipVia`/`DatasourceMembership`/`MembershipDeps`/`buildDatasourceMembership`
  (Task 2); `traceDataFlow(…, opts.datasourceMembership)`, `element.processes[].via`,
  `element.computedInProcesses` (Task 3) — used with the same names across tasks and against the
  Phase-1 `elementKey`/`byElement`/`DataFlowResult.element` contract.
```
