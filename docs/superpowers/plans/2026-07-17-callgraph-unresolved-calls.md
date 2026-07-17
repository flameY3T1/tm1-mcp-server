# Callgraph Unresolved Dynamic Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface dynamic/parameter-target `ExecuteProcess`/`RunProcess` calls (currently silently dropped) as `unresolvedCalls` in `tm1_analyze_callgraph`, so an unresolvable call is a visible marker instead of an invisible omission.

**Architecture:** The reference extractor drops any call whose target arg isn't a literal (`referenceIndex.ts` `pushRef`). We record process-call drops as `UnresolvedCall`s into a new index map, attach them to each downstream call-graph node, and serialize them per output mode. No target resolution is attempted (statically impossible) — only visibility.

**Tech Stack:** TypeScript (strict), vitest. Pure functions in `src/lib/callgraph/`; MCP tool handler in `src/tools/analysis/`.

## Global Constraints

- New TM1 REST calls go in a service under `src/tm1-client/services/` — N/A here (pure analysis code, no new REST).
- Every tool declares annotation hints — N/A (no new tool; `tm1_analyze_callgraph` already annotated).
- Strict output schemas: new handler field must be schema-allowed. **`CallgraphResultSchema` (src/tools/schemas/items.ts) is `.passthrough()` with `tree`/`summary` typed `z.unknown()` and `ranking: z.array(z.unknown())` — so new nested fields need NO schema change.** Do not edit the schema.
- Secrets: mask via `src/lib/mask-secrets.ts`; the `unresolvedCalls` snippet is a code line → mask it with `maskCodeLine` in full mode when `maskSecrets` is on.
- Conventional Commits; one logical change per commit. No real customer/server names in tests/docs.
- Verify with `npm run verify` (typecheck strict + lint gates + tests). CI runs the same.
- Scope: process calls only. Cube/dimension unresolved refs stay dropped (out of scope).
- `reason: 'param'` = callee is a process parameter; `'dynamic'` = everything else (concat/CellGet/computed/multi-assign).

---

### Task 1: Extraction — record unresolved process calls into the reference index

**Files:**
- Modify: `src/lib/callgraph/referenceIndex.ts` (types, `extractTiReferences`, `pushTi`, `buildReferenceIndex`)
- Modify: `tests/unit/callgraph-global-ranking.test.ts` and `tests/unit/data-flow.test.ts` (hand-built `ReferenceIndex` literals need the new field)
- Test: `tests/unit/callgraph-unresolved.test.ts` (create)

**Interfaces:**
- Consumes: `resolveExpression`, `VarBinding` (from `variableEnv.js`, already imported); `PROCESS_CALL_FUNCS` (module const).
- Produces: exported `interface UnresolvedCall { section: RefSection; line: number; funcName: string; expr: string; snippet: string; reason: 'dynamic' | 'param' }`; `ReferenceIndex.unresolvedCallsBySourceProcess: Map<string, UnresolvedCall[]>` (key = lowercased source process name); `extractTiReferences(text, env?, sharedLiveVars?, unresolvedOut?)` gains a 4th optional out-param.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/callgraph-unresolved.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractTiReferences } from "../../src/lib/callgraph/referenceIndex.js";
import { buildProcessEnv } from "../../src/lib/callgraph/variableEnv.js";

// extractTiReferences(text, env?, sharedLiveVars?, unresolvedOut?) — 4th arg collects
// process-call sites whose target could not be resolved to a literal.

describe("extractTiReferences — unresolved process calls", () => {
  it("records a dynamic (concatenated) ExecuteProcess target", () => {
    const unresolved: unknown[] = [];
    const refs = extractTiReferences(
      "sDyn = 'te' | 'st';\nExecuteProcess(sDyn);",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(unresolved).toEqual([
      { line: 1, funcName: "ExecuteProcess", expr: "sDyn", snippet: "ExecuteProcess(sDyn);", reason: "dynamic" },
    ]);
    // no resolved process edge for the dynamic call
    expect(refs.filter((r) => r.targetKind === "process")).toEqual([]);
  });

  it("classifies a parameter-target call as reason 'param'", () => {
    const env = buildProcessEnv("ExecuteProcess(pProc);", ["pProc"]);
    const unresolved: unknown[] = [];
    extractTiReferences("ExecuteProcess(pProc);", env, undefined, unresolved as never);
    expect(unresolved).toHaveLength(1);
    expect((unresolved[0] as { reason: string }).reason).toBe("param");
  });

  it("does NOT flag a literal or single-literal-variable target (no false positive)", () => {
    const unresolved: unknown[] = [];
    const refs = extractTiReferences(
      "sD = 'test';\nExecuteProcess('test');\nExecuteProcess(sD);",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(unresolved).toEqual([]);
    // both the literal and the literal-var call resolve to 'test'
    expect(refs.filter((r) => r.targetKind === "process" && r.targetName === "test")).toHaveLength(2);
  });

  it("does NOT record dynamic CUBE targets (scope guard — process calls only)", () => {
    const unresolved: unknown[] = [];
    extractTiReferences(
      "sDyn = 'a' | 'b';\nnV = CellGetN(sDyn, 'x');",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(unresolved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/callgraph-unresolved.test.ts`
Expected: FAIL — `extractTiReferences` ignores the 4th arg / does not populate it.

- [ ] **Step 3: Add the types**

In `src/lib/callgraph/referenceIndex.ts`, in the Types section (after `TmReference`, ~line 81), add the exported type:

```ts
export interface UnresolvedCall {
  section: RefSection;          // prolog | metadata | data | epilog
  line: number;                 // 0-based within section text
  funcName: string;             // ExecuteProcess | RunProcess
  expr: string;                 // raw target-arg text, e.g. "sDyn" or "'te'|'st'"
  snippet: string;              // trimmed source line
  reason: 'dynamic' | 'param';  // param = callee is a process parameter
}
```

Add the field to the `ReferenceIndex` interface (after `bySourceProcess`):

```ts
  /** Process name (lowercased) → unresolved ExecuteProcess/RunProcess call sites (dynamic/param target). */
  unresolvedCallsBySourceProcess: Map<string, UnresolvedCall[]>;
```

Add an internal raw type next to `RawTiRef` (~line 156):

```ts
interface RawUnresolvedCall {
  line: number;
  funcName: string;
  expr: string;
  snippet: string;
  reason: 'dynamic' | 'param';
}
```

- [ ] **Step 4: Record unresolved calls in `extractTiReferences`**

Change the signature to accept an out-param (4th arg):

```ts
export function extractTiReferences(
  text: string,
  env?: ProcessEnv,
  sharedLiveVars?: Map<string, VarBinding>,
  unresolvedOut?: RawUnresolvedCall[],
): RawTiRef[] {
```

Inside `pushRef`, replace the drop branch. Current:

```ts
        if (targetName === null) {
          const binding = resolveExpression(argVal, callerEnv);
          if (binding.kind !== 'literal') { return; }
          targetName = binding.value;
        }
```

with:

```ts
        if (targetName === null) {
          const binding = resolveExpression(argVal, callerEnv);
          if (binding.kind !== 'literal') {
            // Surface (do not resolve) a process-call whose target is not a literal.
            if (unresolvedOut && kind === 'process' && PROCESS_CALL_FUNCS.has(funcLower)) {
              unresolvedOut.push({
                line: lineIdx,
                funcName: m![1]!,
                expr: argVal.trim(),
                snippet,
                reason: binding.kind === 'param' ? 'param' : 'dynamic',
              });
            }
            return;
          }
          targetName = binding.value;
        }
```

- [ ] **Step 5: Run the extraction test to verify it passes**

Run: `npx vitest run tests/unit/callgraph-unresolved.test.ts`
Expected: PASS (the first 4 tests; the integration test is added in Step 8).

- [ ] **Step 6: Collect into the index in `pushTi` + `buildReferenceIndex`**

In `buildReferenceIndex`, add a collector map next to `const all: TmReference[] = [];`:

```ts
  const unresolvedCallsBySourceProcess = new Map<string, UnresolvedCall[]>();
```

Change `pushTi` to pass an out-array and bucket the results with their section:

```ts
  const pushTi = (
    sourceName: string,
    section: RefSection,
    text: string,
    env: ProcessEnv,
    sharedLiveVars: Map<string, VarBinding>,
  ) => {
    if (!text) { return; }
    const unresolvedOut: RawUnresolvedCall[] = [];
    for (const r of extractTiReferences(text, env, sharedLiveVars, unresolvedOut)) {
      all.push({
        sourceKind: 'process',
        sourceName,
        section,
        line: r.line,
        snippet: r.snippet,
        funcName: r.funcName,
        targetKind: r.targetKind,
        targetName: r.targetName,
        params: r.params,
      });
    }
    if (unresolvedOut.length > 0) {
      const key = sourceName.toLowerCase();
      const arr = unresolvedCallsBySourceProcess.get(key) ?? [];
      for (const u of unresolvedOut) { arr.push({ section, ...u }); }
      unresolvedCallsBySourceProcess.set(key, arr);
    }
  };
```

Add the field to the returned index object (the `return { all, byCube, ... }` near the end of `buildReferenceIndex`):

```ts
  return { all, byCube, byDim, byProcess, bySourceProcess, processParams, processDefaults, choreTasks, unresolvedCallsBySourceProcess };
```

- [ ] **Step 7: Fix the hand-built `ReferenceIndex` test fixtures**

Two tests construct a `ReferenceIndex` object literal and will now fail typecheck (missing field). In `tests/unit/callgraph-global-ranking.test.ts` and `tests/unit/data-flow.test.ts`, find each object literal that sets `bySourceProcess:` and add:

```ts
    unresolvedCallsBySourceProcess: new Map(),
```

(If a shared helper builds the index in those files, add the field there once.)

- [ ] **Step 8: Add an index-level integration test**

Append to `tests/unit/callgraph-unresolved.test.ts` (mirror the `buildReferenceIndex` deps harness used in `tests/unit/callgraph-global-ranking.test.ts` — same `fetchProcesses`/`fetchCubesWithRules`/`fetchChores` injection):

```ts
import { buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";

describe("buildReferenceIndex — unresolvedCallsBySourceProcess", () => {
  it("buckets unresolved calls per source process with section", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "P", prolog: "sDyn = 'a' | 'b';\nExecuteProcess(sDyn);", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    expect(index.unresolvedCallsBySourceProcess.get("p")).toEqual([
      { section: "prolog", line: 1, funcName: "ExecuteProcess", expr: "sDyn", snippet: "ExecuteProcess(sDyn);", reason: "dynamic" },
    ]);
  });
});
```

If the `BuildIndexDeps` shape differs (e.g. `parameters` optional, extra fields), copy the exact deps object shape from `callgraph-global-ranking.test.ts` and only vary the process code.

- [ ] **Step 9: Run tests + full verify**

Run: `npx vitest run tests/unit/callgraph-unresolved.test.ts`
Expected: PASS (all 5).
Run: `npm run verify`
Expected: green (the two fixture edits keep typecheck happy).

- [ ] **Step 10: Commit**

```bash
git add src/lib/callgraph/referenceIndex.ts tests/unit/callgraph-unresolved.test.ts tests/unit/callgraph-global-ranking.test.ts tests/unit/data-flow.test.ts
git commit -m "feat(callgraph): record unresolved dynamic/param process calls in the reference index"
```

---

### Task 2: Graph nodes + handler serialization

**Files:**
- Modify: `src/lib/callgraph/callGraph.ts` (`CallGraphNode`, `buildCallGraph`)
- Modify: `src/tools/analysis/analyze-callgraph.ts` (`serializeNode`, `CompactNode`/`serializeCompact`, `SummaryEntry`/`summarize`, tool description)
- Test: `tests/unit/callgraph-unresolved-nodes.test.ts` (create)

**Interfaces:**
- Consumes: `ReferenceIndex.unresolvedCallsBySourceProcess`, `UnresolvedCall` (Task 1).
- Produces: `CallGraphNode.unresolvedCalls?: UnresolvedCall[]` (downstream only); full-mode node gains `unresolvedCalls` (masked snippet); compact node gains `unresolvedCalls` (no snippet); `SummaryEntry` gains `unresolvedCount`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/callgraph-unresolved-nodes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";
import { buildCallGraph } from "../../src/lib/callgraph/callGraph.js";

async function indexWithDynamicCall() {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      { name: "Orchestrator", prolog: "ExecuteProcess('Child');\nsDyn = 'a' | 'b';\nExecuteProcess(sDyn);", metadata: "", data: "", epilog: "", parameters: [] },
      { name: "Child", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

describe("buildCallGraph — unresolvedCalls on nodes", () => {
  it("attaches unresolvedCalls to the downstream root node", async () => {
    const index = await indexWithDynamicCall();
    const tree = buildCallGraph(index, "Orchestrator", { direction: "downstream" });
    // resolved literal call is a child
    expect(tree.children.map((c) => c.process)).toContain("Child");
    // dynamic call surfaces as unresolved on the node itself
    expect(tree.unresolvedCalls).toEqual([
      { section: "prolog", line: 2, funcName: "ExecuteProcess", expr: "sDyn", snippet: "ExecuteProcess(sDyn);", reason: "dynamic" },
    ]);
  });

  it("does not attach unresolvedCalls in the upstream direction", async () => {
    const index = await indexWithDynamicCall();
    const tree = buildCallGraph(index, "Orchestrator", { direction: "upstream" });
    expect(tree.unresolvedCalls).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/callgraph-unresolved-nodes.test.ts`
Expected: FAIL — `tree.unresolvedCalls` is undefined.

- [ ] **Step 3: Add the field + populate it in `callGraph.ts`**

Import the type at the top of `src/lib/callgraph/callGraph.ts`:

```ts
import type { ReferenceIndex, TmReference, CallParam, CallParamResolution, UnresolvedCall } from './referenceIndex.js';
```

Add to `CallGraphNode` (after `children`):

```ts
  /** Outgoing calls whose target could not be statically resolved (downstream only). */
  unresolvedCalls?: UnresolvedCall[] | undefined;
```

Add a helper above `buildCallGraph`:

```ts
function unresolvedFor(
  index: ReferenceIndex,
  process: string,
  direction: Direction,
): UnresolvedCall[] | undefined {
  if (direction !== 'downstream') { return undefined; }
  const u = index.unresolvedCallsBySourceProcess.get(lc(process));
  return u && u.length > 0 ? u : undefined;
}
```

Populate on the root node (in the `const root: CallGraphNode = {...}` literal, add):

```ts
    unresolvedCalls: unresolvedFor(index, start, opts.direction),
```

Populate on each child node (in the `const childNode: CallGraphNode = {...}` literal inside `visit`, add):

```ts
        unresolvedCalls: unresolvedFor(index, nextProc, opts.direction),
```

- [ ] **Step 4: Run the node test to verify it passes**

Run: `npx vitest run tests/unit/callgraph-unresolved-nodes.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Serialize in the handler (`analyze-callgraph.ts`)**

**Full mode** — in `serializeNode`, add `unresolvedCalls` to the returned object (mask the snippet when `mask`):

```ts
    unresolvedCalls: node.unresolvedCalls
      ? node.unresolvedCalls.map((u) => ({
          section: u.section,
          line: u.line,
          funcName: u.funcName,
          expr: u.expr,
          snippet: mask ? maskCodeLine(u.snippet) : u.snippet,
          reason: u.reason,
        }))
      : undefined,
```

**Compact mode** — extend `CompactNode` and `serializeCompact`. Add to the interface:

```ts
  unresolvedCalls?: Array<{ section: string; line: number; funcName: string; expr: string; reason: string }>;
```

In `serializeCompact`, after the cycle/depthLimit assignments:

```ts
  if (node.unresolvedCalls && node.unresolvedCalls.length > 0) {
    out.unresolvedCalls = node.unresolvedCalls.map((u) => ({
      section: u.section,
      line: u.line,
      funcName: u.funcName,
      expr: u.expr,
      reason: u.reason,
    }));
  }
```

(Compact deliberately omits the snippet, consistent with compact dropping snippets/params.)

**Summary mode** — add `unresolvedCount: number` to `SummaryEntry`, and in `summarize`'s `walk`, set it once per unique process (only when the entry is first created):

```ts
    } else {
      map.set(node.process, {
        process: node.process,
        depthMin: depth,
        depthMax: depth,
        occurrences: 1,
        cycle: isCycle,
        depthLimitReached: isDepthLimit,
        unresolvedCount: node.unresolvedCalls?.length ?? 0,
      });
    }
```

(unresolvedCalls is identical across occurrences of the same process, so counting once is correct.)

- [ ] **Step 6: Update the tool description**

In `registerAnalyzeCallgraph`, append to the `tm1_analyze_callgraph` description string:

```
 ExecuteProcess/RunProcess calls whose target is a computed expression or a process parameter (not statically resolvable) are surfaced per node as `unresolvedCalls` (full/compact) or `unresolvedCount` (summary) — flagged, not resolved.
```

- [ ] **Step 7: Run tests + full verify**

Run: `npx vitest run tests/unit/callgraph-unresolved-nodes.test.ts`
Expected: PASS.
Run: `npm run verify`
Expected: green. (No output-schema edit: `CallgraphResultSchema.tree`/`summary` are `z.unknown()` + `.passthrough()`, so the new fields are accepted.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/callgraph/callGraph.ts src/tools/analysis/analyze-callgraph.ts tests/unit/callgraph-unresolved-nodes.test.ts
git commit -m "feat(callgraph): surface unresolvedCalls per node (full/compact) and unresolvedCount (summary)"
```

---

### Task 3: Live validation + docs

**Files:**
- Modify: `README.md` (callgraph tool note)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- (Optional live-run — controller-driven; no file change)

**Interfaces:** none (docs + manual live probe).

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- `tm1_analyze_callgraph` now surfaces `ExecuteProcess`/`RunProcess` calls whose
  target is a computed expression or a process parameter as `unresolvedCalls`
  (full/compact modes) / `unresolvedCount` (summary) instead of silently dropping
  them. The call is flagged for manual review — not resolved (statically impossible).
```

- [ ] **Step 2: README note**

In `README.md`, locate the `tm1_analyze_callgraph` entry (regenerated tool list or a hand-written analysis section). If the tool list is generated, run `npm run tools:update-readme` to pick up the new description; otherwise add a one-line note that dynamic/param-target calls appear as `unresolvedCalls`. Run:

```bash
npm run tools:update-readme
```

- [ ] **Step 3: Verify**

Run: `npm run verify`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(callgraph): document unresolvedCalls for dynamic/param process targets"
```

- [ ] **Step 5: Live validation (controller-run, optional)**

Against the v12 test MCP server (`tm1-v12`): create a fixture process with a dynamic call, run `tm1_analyze_callgraph`, confirm `unresolvedCalls` appears, then delete it:

```
tm1_upsert_process(name="zUnresolvedTest", mode="create",
  prolog="ExecuteProcess('test');\nsDyn = 'te' | 'st';\nExecuteProcess(sDyn);")
tm1_analyze_callgraph(start="zUnresolvedTest", direction="downstream")
  → expect child "test" AND unresolvedCalls: [{ expr:"sDyn", reason:"dynamic", ... }]
tm1_delete_process(processName="zUnresolvedTest", confirm="zUnresolvedTest")
```

---

## Notes for the executor

- **No output-schema change**: `CallgraphResultSchema` is intentionally permissive (`tree`/`summary` = `z.unknown()`, `.passthrough()`). Do not add fields to it — a stricter schema would be a larger, unrelated change.
- **Deferred (out of scope)**: `unresolvedCount` on the global-ranking entries (`RankEntry`) — needs source-name casing reconciliation for processes that have *only* unresolved calls; marginal value, omitted. Also: unresolved cube/dimension refs in `tm1_analyze_object_usage` (different, name-keyed query).
- **No false positives**: literal and single-literal-variable targets already resolve to real edges (validated live) — the `reason` branch only fires when `resolveExpression` returns non-literal.
