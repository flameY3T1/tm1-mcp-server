# Bucket C1 — Targeted Computed-Axis Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Depends on Bucket A + Phase 1.5 + Bucket B, all merged (`286b6c2`).** Extends Bucket B's
> `datasourceMembership.ts` and the `tm1_trace_data_flow` element filter.

**Goal:** When a native-view axis carries an inline **computed** MDX `expression` (a selector that
scopes elements without naming them, e.g. `{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}`) and it is
used as a process datasource, optionally resolve just that one dimension-scoped set — via a read-only
members-only MDX query against the view's cube — so the traced element becomes an exact `source` hit
instead of only a `computedInProcesses` flag. Opt-in; honest on failure.

**Architecture:** Extend `buildDatasourceMembership` (Bucket B) with an optional injected
`evaluateSetExpression` dep. For a native columns/rows axis whose inline `expression` contains a
computed selector, if the dep is provided, evaluate that set and add its resolved members as exact
element refs (`via:'view-native-computed'`). The dep is wired in the tool handler to the EXISTING
`tm1Client.cells.executeMdx` (no new REST/service method). Gated behind a new opt-in `resolveComputed`
tool input (default off) because it performs live evaluations during analysis.

**Tech Stack:** TypeScript (strict), vitest. Pure-ish adapter in `src/lib/callgraph/`; MCP handler in
`src/tools/analysis/`; existing `CellService.executeMdx`.

## Global Constraints

- **Service composition:** the members-eval reuses `tm1Client.cells.executeMdx` (an existing service
  method) — NO new flat API, NO new service method. The handler wraps it into the injected
  `evaluateSetExpression` closure. `lint:no-flat-api` stays green.
- **Strict output schema:** `element.processes[].via` is already `z.array(z.string()).optional()`
  (Bucket B) — adding the `'view-native-computed'` value needs **NO schema change**. Do not touch
  `DataFlowResultSchema` (output-schema-budget is at 97.0% — leave it).
- **Read-only:** the eval uses `SELECT {expr} ON 0 FROM [cube]` (members read; no temp object, no data
  mutation). `tm1_trace_data_flow` stays annotated read-only.
- **Honesty:** on any eval error/timeout → record in `fetchErrors` (already surfaced in `resolution`)
  and leave the process in `computedInProcesses`. Never drop, never false-claim. The word "unused"
  appears nowhere.
- **Opt-in:** `resolveComputed` defaults to `false`; when off, behavior is byte-identical to today.
- Conventional Commits; one logical change per commit; synthetic names in tests.
- After tool description change: `npm run tools:update-readme`.

## Verified current-state facts (do not re-derive)

- `datasourceMembership.ts` (Bucket B): `MembershipVia = "view-mdx" | "view-native-title" |
  "view-native-expr" | "subset-static" | "subset-mdx"` (`:7-12`); `MembershipDeps { getViewDefinition;
  getSubset }` (`:23-26`); `buildDatasourceMembership(deps, dsList)` with helpers `addMember`,
  `addMdx` (calls `extractMdxMemberRefs` → literal members + `addComputed`), `applySubset`; native
  handling: titles → `selectedElement` only (`:73-76`), columns/rows → `if (ax.expression) addMdx(...,
  "view-native-expr") else if (ax.subsetName) getSubset+applySubset` (`:79-85`). Per-object try/catch
  → `rethrowIfSystemic` guarded + `fetchErrors`.
- `extractMdxMemberRefs(mdx)` → `{ members: {dimension,element}[]; computedSelectors: string[] }`
  (`mdxMembers.ts`). Computed selectors non-empty ⇒ the expression scopes members computedly.
- `CellService.executeMdx(mdx, top?, skip?, opts?): Promise<MdxResult>` — `src/tm1-client/services/cell-service.ts:87`.
  `MdxResult.axes[i].tuples[j].members[k]` carries `name` + `hierarchyName` (transformed shape;
  confirm exact field names in `cellset-transform.ts` before use). Cellset is freed automatically.
- `tm1Client.cells` is the `CellService` (`tm1-client.ts:42,61`).
- Live-verified (spec): a native anonymous computed axis returns as inline `expression` (not a
  `subsetName`); `SELECT {expr} ON 0 FROM [cube]` returns `axes[0]` members = the resolved set (e.g.
  `[EUR,CHF,USD,Group_EUR]`), other dims auto-defaulted into `axes[1]`.
- Handler `trace-data-flow.ts` builds `datasourceMembership` when `element && dimension &&
  resolveDatasourceMembership`, passing `{ getViewDefinition, getSubset }` from `tm1Client.views`/
  `tm1Client.subsets`; keeps `elementAccess` passthrough. `traceDataFlow` merges Bucket-B hits as
  `source` + `via`.

---

### Task 1: `evaluateSetExpression` dep + computed-axis resolution in the adapter

**Files:**
- Modify: `src/lib/callgraph/datasourceMembership.ts`
- Test: `tests/unit/datasource-membership.test.ts` (extend)

**Interfaces:**
- Produces:
  - `MembershipVia` gains `"view-native-computed"`.
  - `MembershipDeps` gains optional
    `evaluateSetExpression?(cube: string, dimension: string, mdxSet: string): Promise<string[]>`
    (resolved member names of the set, already scoped to `dimension`).
  - Native columns/rows axis handling: when `ax.expression` has computed selectors AND
    `deps.evaluateSetExpression` is provided, resolve the set and add each member under
    `ax.dimensionName` with `via:"view-native-computed"`. A per-`(cube,expression)` in-run cache avoids
    re-evaluating a shared axis.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/datasource-membership.test.ts`:

```ts
describe("buildDatasourceMembership — computed axis resolution (C1)", () => {
  it("resolves a computed native-axis expression via evaluateSetExpression", async () => {
    const calls: Array<{ cube: string; dim: string; set: string }> = [];
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: {
            titles: [],
            columns: [],
            rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }],
          },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        evaluateSetExpression: async (cube: string, dim: string, set: string) => {
          calls.push({ cube, dim, set });
          return ["EUR", "CHF", "USD", "Group_EUR"];
        },
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "Cube_Assumptions", view: "vC" }],
    );
    expect(m.byElement.get(elementKey("Currency", "USD"))).toEqual([{ process: "P", via: "view-native-computed" }]);
    expect(calls).toEqual([{ cube: "Cube_Assumptions", dim: "Currency", set: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }]);
    // computed selector still recorded (honest provenance) even though resolved
    expect([...(m.computedByProcess.get("P") ?? [])]).toContain("TM1FILTERBYLEVEL");
  });

  it("without evaluateSetExpression, a computed axis stays flagged (no members)", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: { titles: [], columns: [], rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }] },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        // no evaluateSetExpression
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vC" }],
    );
    expect(m.byElement.get(elementKey("Currency", "USD"))).toBeUndefined();
    expect([...(m.computedByProcess.get("P") ?? [])]).toContain("TM1FILTERBYLEVEL");
  });

  it("eval failure is recorded in fetchErrors and does not throw", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: { titles: [], columns: [], rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{DESCENDANTS([Currency].[x])}" }] },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        evaluateSetExpression: async () => { throw new Error("bad mdx"); },
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vC" }],
    );
    expect(m.byElement.size).toBe(0);
    expect(m.fetchErrors.some((e) => e.process === "P" && /eval/i.test(e.object))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run tests/unit/datasource-membership.test.ts`).

- [ ] **Step 3: Extend the type + dep**

In `datasourceMembership.ts`, add to `MembershipVia`:

```ts
  | "view-native-computed"
```

Add to `MembershipDeps`:

```ts
  /** C1 (opt-in): resolve a computed axis set to its concrete member names, already scoped to `dimension`. */
  evaluateSetExpression?(cube: string, dimension: string, mdxSet: string): Promise<string[]>;
```

- [ ] **Step 4: Resolve computed axis expressions**

In the columns/rows axis loop, restructure the `if (ax.expression)` branch. Currently it calls
`addMdx(ds.name, ax.expression, "view-native-expr")` (literal members + computed flag). Keep that
behavior, then add computed resolution. Because the branch needs to know whether the expression was
computed and needs the cube, replace the single `addMdx` call with an inline expansion:

```ts
if (ax.expression) {
  const { members, computedSelectors } = extractMdxMemberRefs(ax.expression);
  for (const ref of members) addMember(ds.name, ref.dimension, ref.element, "view-native-expr");
  addComputed(ds.name, computedSelectors);
  // C1: if this axis is computed and a resolver is provided, resolve it exactly.
  if (computedSelectors.length > 0 && deps.evaluateSetExpression && ax.dimensionName) {
    const cacheKey = `${ds.sourceName!.toLowerCase()} ${ax.expression}`;
    let names = evalCache.get(cacheKey);
    if (names === undefined) {
      names = await deps.evaluateSetExpression(ds.sourceName!, ax.dimensionName, ax.expression);
      evalCache.set(cacheKey, names);
    }
    for (const name of names) addMember(ds.name, ax.dimensionName, name, "view-native-computed");
  }
} else if (ax.subsetName && ax.dimensionName) {
  const sub = await deps.getSubset(ax.dimensionName, ax.hierarchyName ?? ax.dimensionName, ax.subsetName);
  applySubset(ds.name, sub);
}
```

Declare the cache near the top of `buildDatasourceMembership` (per-run):

```ts
const evalCache = new Map<string, string[]>();
```

> `addComputed`/`extractMdxMemberRefs` are already in scope (used by `addMdx`). Keep `addMdx` — it is
> still used for the MDX-view `def.mdx` (`view-mdx`) and subset `expression` (`subset-mdx`) paths.
> The eval call must be inside the EXISTING per-object `try/catch` around the datasource loop so a
> failure records a `fetchErrors` entry. Make the recorded `object` string identify it as an eval
> failure so the test's `/eval/i` matches — either widen the existing catch's `object` label or wrap
> just the `evaluateSetExpression` call in a nested try that pushes
> `{ process: ds.name, object: `eval ${ds.sourceName}/${ax.dimensionName}`, message }` to `fetchErrors`
> and continues (still honoring `rethrowIfSystemic` for systemic TM1Errors).

- [ ] **Step 5: Run — expect PASS** (`npx vitest run tests/unit/datasource-membership.test.ts`).

- [ ] **Step 6: Full verify + commit**

Run: `npm run verify` → green (no schema change; `via` is already loose `z.array(z.string())`).

```bash
git add src/lib/callgraph/datasourceMembership.ts tests/unit/datasource-membership.test.ts
git commit -m "feat(callgraph): resolve computed native-axis expressions to exact members (Bucket C1, opt-in dep)"
```

---

### Task 2: Wire `evaluateSetExpression` + `resolveComputed` tool input

**Files:**
- Modify: `src/tools/analysis/trace-data-flow.ts`
- Test: (covered by Task 1 unit + Task 3 live; no `*-tool.test.ts` exists for this tool, consistent
  with the repo)

**Interfaces:**
- Consumes: `buildDatasourceMembership` (now accepts `evaluateSetExpression`), `tm1Client.cells.executeMdx`.
- Produces: new tool input `resolveComputed?: boolean` (default `false`); when true, the handler passes
  an `evaluateSetExpression` closure into `buildDatasourceMembership`.

- [ ] **Step 1: Add the tool input**

In `trace-data-flow.ts`, after `resolveDatasourceMembership`:

```ts
      resolveComputed: z
        .boolean()
        .optional()
        .default(false)
        .describe("When tracing an element, additionally RESOLVE computed native-view axis selectors (e.g. TM1FILTERBYLEVEL/DESCENDANTS) by live-evaluating just that dimension's set against the view's cube (read-only). Off by default (extra queries). Only affects native-view axis expressions; stored subsets are already resolved exactly."),
```

- [ ] **Step 2: Build the `evaluateSetExpression` closure and pass it**

In the handler, in the `if (element && dimension && resolveDatasourceMembership)` block, add the
resolver only when `resolveComputed`:

```ts
      let datasourceMembership;
      if (element && dimension && resolveDatasourceMembership) {
        datasourceMembership = await buildDatasourceMembership(
          {
            getViewDefinition: (cube, view) => tm1Client.views.getDefinition(cube, view),
            getSubset: (dim, hier, sub) => tm1Client.subsets.get(dim, hier, sub),
            ...(resolveComputed
              ? {
                  evaluateSetExpression: async (cube: string, dimension: string, mdxSet: string): Promise<string[]> => {
                    const res = await tm1Client.cells.executeMdx(`SELECT {${mdxSet}} ON 0 FROM [${cube}]`, 1);
                    const axis0 = res.axes[0];
                    if (!axis0) return [];
                    const wantHier = dimension.toLowerCase();
                    const names: string[] = [];
                    for (const t of axis0.tuples) {
                      for (const mem of t.members) {
                        // Confirm the transformed member field names in cellset-transform.ts:
                        // expected { name, hierarchyName }.
                        if (mem.hierarchyName?.toLowerCase() === wantHier) names.push(mem.name);
                      }
                    }
                    return names;
                  },
                }
              : {}),
          },
          dsList,
        );
      }
```

(Adjust the handler arg destructure to include `resolveComputed`. `top=1` minimizes cell payload; we
read only `axes[0]` members.)

Append a sentence to the tool description `.join(" ")` array:

```ts
      "With resolveComputed=true, computed native-view axis selectors are resolved to exact members (via 'view-native-computed'); otherwise they stay flagged in computedInProcesses.",
```

- [ ] **Step 3: Verify + README + commit**

Run: `npm run verify` → green (**no schema change** — confirm `lint:output-schema-budget` unchanged at
97.0%). Then `npm run tools:update-readme`.

```bash
git add src/tools/analysis/trace-data-flow.ts README.md
git commit -m "feat(trace-data-flow): resolveComputed input wires live members-eval for computed axes (Bucket C1)"
```

> **Field-name check (blocking for Step 2):** verify `MdxResult.axes[].tuples[].members[]` exposes
> `name` and `hierarchyName` (via `cellset-transform.ts`). If the transformed field is `hierarchy`
> (object) instead of `hierarchyName` (string), adjust the filter. If members lack a hierarchy field
> entirely, drop the hierarchy filter and trust the single-dim axis (the set is one dimension) — but
> prefer the filter when the field exists.

---

### Task 3: Live validation + docs

**Files:** Modify `CHANGELOG.md` (`[Unreleased]`); live probe (controller-driven).

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` → `### Added`:

```markdown
- `tm1_trace_data_flow` element tracing gains opt-in `resolveComputed`: when set, computed native-view
  axis selectors (`TM1FILTERBYLEVEL`/`DESCENDANTS`/…) used as datasources are resolved to exact members
  by live-evaluating just that dimension's set against the view's cube (read-only, `via:view-native-computed`).
  Off by default; when off, such axes stay flagged in `computedInProcesses`. Stored subsets are already
  resolved exactly and are unaffected.
```

- [ ] **Step 2: Live probe (tm1-test)**

```
# create a native view whose ROW axis is a computed anonymous expression, on a real cube+dim
tm1_create_native_view(cubeName="Cube_Assumptions", viewName="zC1Live",
  rows=[{dimension:"Currency", expression:"{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}"}],
  columns=[{dimension:"Measure_Assumption", expression:"{TM1SUBSETALL([Measure_Assumption])}"}],
  titles=[{dimension:"Time_Month", expression:"{TM1SUBSETALL([Time_Month])}", selected:"Total_Time"},
          {dimension:"Version", expression:"{TM1SUBSETALL([Version])}", selected:"Actual"},
          {dimension:"Location", expression:"{TM1SUBSETALL([Location])}", selected:"Total_Location"}])
tm1_upsert_process(name="zC1Proc", mode="create", prolog="# reads via computed native view",
  dataSource={type:"TM1CubeView", dataSourceNameForServer:"Cube_Assumptions", view:"zC1Live"})

# off (default) → USD not resolved from this view, process flagged
tm1_trace_data_flow(cubeName="Cube_Assumptions", element="USD", dimension="Currency")
  → expect zC1Proc in element.computedInProcesses; NOT source-from-this-view in element.processes

# on → USD resolved exactly
tm1_trace_data_flow(cubeName="Cube_Assumptions", element="USD", dimension="Currency", resolveComputed=true)
  → expect element.processes contains { process:"zC1Proc", access:["source"], via:["view-native-computed"] }

# cleanup
tm1_delete_process(processName="zC1Proc", confirm="zC1Proc")
tm1_delete_view(cubeName="Cube_Assumptions", viewName="zC1Live", confirm="zC1Live")
```

(`Cube_Assumptions` + dims Time_Month/Version/Location/Currency/Measure_Assumption and title defaults
Total_Time/Actual/Total_Location are live-confirmed on tm1-test; adjust if the target server differs.)

- [ ] **Step 3: Commit** `git commit -m "docs(trace-data-flow): changelog for Bucket C1 computed-axis resolution"`

---

## Notes for the executor

- **No new REST/service method** — reuse `tm1Client.cells.executeMdx`. Do not add a method to a service.
- **No schema change** — `via` is already `z.array(z.string())`. Do NOT touch `DataFlowResultSchema`
  (budget 97.0%).
- **Read-only** — the eval is a members read (`ON 0`, no temp object). Keep it so; never create a
  subset/view to resolve.
- **Honest failure** — an eval throw must land in `fetchErrors` (surfaced in `resolution`) and leave the
  process flagged in `computedInProcesses`; never a false `source`.
- **Scope is C1 only** — native-view axis inline expressions. Raw MDX views (`def.type==="MDX"`) keep
  `addMdx(def.mdx, "view-mdx")` (literal only) and stay flagged; do NOT attempt to eval a whole
  SELECT (that is deferred C2).
- **Cache** eval results per (cube, expression) within one run (`evalCache`) — an axis shared by
  several processes' views is evaluated once.

## Self-review

- **Spec coverage:** targeted single-dim eval (not whole view) → Task 1 `evaluateSetExpression(cube,
  dimension, mdxSet)` on the isolated `ax.expression`. Read-only members-eval → Task 2 closure over
  `cells.executeMdx` `SELECT {expr} ON 0`. Opt-in `resolveComputed=false` → Task 2 input. Honest
  failure → Task 1 fetchErrors + flag retained. `view-native-computed` via → Task 1. C2 deferred →
  Notes + MDX-view path untouched. Cache → Task 1 `evalCache`.
- **Placeholders:** none.
- **Type consistency:** `MembershipVia += 'view-native-computed'`, `MembershipDeps.evaluateSetExpression`,
  `evalCache`, `resolveComputed` — same names across tasks; member field-name (`hierarchyName`)
  flagged for executor confirmation against `cellset-transform.ts`.
