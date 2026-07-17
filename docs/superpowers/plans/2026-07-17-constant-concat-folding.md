# Constant String-Concat Folding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold constant `|`-concatenations in `resolveExpression` so `sProc = 'zA' | 'zB'; ExecuteProcess(sProc)` resolves to a real edge (`zAzB`) instead of being treated as dynamic/unresolved — improving callgraph edges and object-usage attribution, and shrinking `unresolvedCalls`.

**Architecture:** One change in the single resolution chokepoint `src/lib/callgraph/variableEnv.ts::resolveExpression`: a quote/paren-aware split on top-level `|`; if every operand resolves to a literal, return the concatenated literal, else stay dynamic. All consumers (var-env, callgraph, object-usage) benefit with no per-consumer change.

**Tech Stack:** TypeScript (strict), vitest. Pure functions in `src/lib/callgraph/`.

## Global Constraints

- No new REST calls, no new tools, no schema change, no type change (`VarBinding` already has `literal`/`dynamic`).
- Only the literal `|` string-concat is folded. No `NumberToString`/`%var%`/`SUBST`/arithmetic folding.
- Genuinely-dynamic operands (parameter, DataSource var, function call, `CellGet*`, unknown var) keep the whole expression `dynamic`.
- Conventional Commits; one logical change per commit. No real customer/server names in tests/docs.
- Verify with `npm run verify` (typecheck strict + lint gates + tests). CI runs the same.
- **Cross-feature ripple:** the merged `callgraph-unresolved*` tests use `'te'|'st'` as their *dynamic* example; after folding that resolves. Those fixtures are updated to a genuinely-dynamic form (`sOther`, an unknown/unassigned variable) in the SAME task — else verify goes red.

---

### Task 1: Fold constant concat in `resolveExpression` (+ tests, + fixture flips)

This lands atomically: the folding change flips existing `callgraph-unresolved*` assertions, so those fixtures must be updated in the same commit to keep `npm run verify` green.

**Files:**
- Modify: `src/lib/callgraph/variableEnv.ts` (add `splitTopLevelConcat` + fold branch in `resolveExpression`)
- Create: `tests/unit/variable-env-concat.test.ts`
- Modify: `tests/unit/callgraph-unresolved.test.ts` (flip 3 concat fixtures → `sOther`)
- Modify: `tests/unit/callgraph-unresolved-nodes.test.ts` (flip 1 concat fixture → `sOther`)

**Interfaces:**
- Consumes: existing `resolveExpression(expr, env)`, `buildProcessEnv`, `ProcessEnv`, `VarBinding` (all exported from `variableEnv.js`); `buildReferenceIndex`, `ReferenceIndex.bySourceProcess`/`unresolvedCallsBySourceProcess` (from `referenceIndex.js`).
- Produces: no new exports; `resolveExpression` now folds constant `|`-concatenations.

- [ ] **Step 1: Write the failing resolveExpression tests**

Create `tests/unit/variable-env-concat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveExpression, buildProcessEnv, type ProcessEnv } from "../../src/lib/callgraph/variableEnv.js";

const emptyEnv = (): ProcessEnv => ({
  paramsLc: new Set(),
  paramOriginal: new Map(),
  paramTypes: new Map(),
  datasourceVars: new Map(),
  vars: new Map(),
});

describe("resolveExpression — constant concat folding", () => {
  it("folds two string literals", () => {
    expect(resolveExpression("'te' | 'st'", emptyEnv())).toEqual({ kind: "literal", value: "test" });
  });
  it("folds three literals", () => {
    expect(resolveExpression("'z' | 'Step' | '01'", emptyEnv())).toEqual({ kind: "literal", value: "zStep01" });
  });
  it("folds a literal-bound variable with a literal", () => {
    const env = buildProcessEnv("sA = 'foo';", []); // sA → literal 'foo'
    expect(resolveExpression("sA | 'x'", env)).toEqual({ kind: "literal", value: "foox" });
  });
  it("stays dynamic when an operand is a parameter", () => {
    const env = buildProcessEnv("", ["pInput"]);
    expect(resolveExpression("pInput | 'x'", env)).toEqual({ kind: "dynamic" });
  });
  it("stays dynamic when an operand is a function call", () => {
    expect(resolveExpression("SUBST('abc',1,2) | 'x'", emptyEnv())).toEqual({ kind: "dynamic" });
  });
  it("does not split a pipe inside a string literal", () => {
    expect(resolveExpression("'a|b'", emptyEnv())).toEqual({ kind: "literal", value: "a|b" });
  });
  it("does not split a pipe inside parens", () => {
    expect(resolveExpression("FOO('a|b')", emptyEnv())).toEqual({ kind: "dynamic" });
  });
  it("stays dynamic on a malformed empty operand", () => {
    expect(resolveExpression("'a' | | 'b'", emptyEnv())).toEqual({ kind: "dynamic" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/variable-env-concat.test.ts`
Expected: FAIL — folding cases return `{kind:'dynamic'}` today (only the pipe-in-string and parens cases would pass).

- [ ] **Step 3: Add the splitter + fold branch in `variableEnv.ts`**

Add a module-local helper (near the other helpers, above `resolveExpression`):

```ts
/**
 * Split an expression on top-level '|' (TI string-concat), ignoring '|' inside
 * 'string literals' or (parens). A single-element result means no top-level '|'
 * was found (not a concatenation).
 */
function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  for (const ch of expr) {
    if (ch === "'") { inStr = !inStr; cur += ch; }
    else if (!inStr && ch === '(') { depth++; cur += ch; }
    else if (!inStr && ch === ')') { depth--; cur += ch; }
    else if (!inStr && depth === 0 && ch === '|') { parts.push(cur); cur = ''; }
    else { cur += ch; }
  }
  parts.push(cur);
  return parts;
}
```

In `resolveExpression`, replace the final `return { kind: 'dynamic' };` with the fold branch:

```ts
  // Constant string-concatenation: fold when every operand resolves to a literal.
  const parts = splitTopLevelConcat(e);
  if (parts.length >= 2) {
    const values: string[] = [];
    let allLiteral = true;
    for (const p of parts) {
      const b = resolveExpression(p.trim(), env);
      if (b.kind === 'literal') { values.push(b.value); }
      else { allLiteral = false; break; }
    }
    if (allLiteral) { return { kind: 'literal', value: values.join('') }; }
    return { kind: 'dynamic' };
  }

  return { kind: 'dynamic' };
```

(The `parts.length >= 2` guard means a non-concat expression falls straight through to `dynamic`, unchanged. The recursion terminates: each part has no top-level `|`, so it resolves via the literal/numeric/identifier branches or the 1-part `dynamic` fall-through.)

- [ ] **Step 4: Run the concat tests to verify they pass**

Run: `npx vitest run tests/unit/variable-env-concat.test.ts`
Expected: PASS (all 8).

- [ ] **Step 5: Add the integration test (concat resolves to an edge)**

Append to `tests/unit/variable-env-concat.test.ts`:

```ts
import { buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";

describe("buildReferenceIndex — constant-concat call resolves to an edge", () => {
  it("resolves ExecuteProcess(concat) to a real edge, not unresolved", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "P", prolog: "sProc = 'zA' | 'zB';\nExecuteProcess(sProc);", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    expect(
      index.bySourceProcess.get("p")?.some((r) => r.targetKind === "process" && r.targetName === "zAzB"),
    ).toBe(true);
    expect(index.unresolvedCallsBySourceProcess.get("p")).toBeUndefined();
  });
});
```

Run: `npx vitest run tests/unit/variable-env-concat.test.ts`
Expected: PASS (all 9).

- [ ] **Step 6: Flip the ripple fixtures in `callgraph-unresolved.test.ts`**

Three fixtures use constant concat as the "dynamic" example; replace the concat with an unknown variable `sOther` (resolves to dynamic, stable under folding). Apply these exact replacements:

1. In the first test, replace the input string `"sDyn = 'te' | 'st';\nExecuteProcess(sDyn);"` with `"sDyn = sOther;\nExecuteProcess(sDyn);"`. Also retitle that `it(...)` from `"records dynamic (concatenated) ExecuteProcess target"` to `"records dynamic ExecuteProcess target (unresolvable variable)"`. (All assertions — `line: 1`, `expr: "sDyn"`, `snippet: "ExecuteProcess(sDyn);"`, `reason: "dynamic"` — stay the same.)
2. In the CUBE scope-guard test, replace `"sDyn = 'a' | 'b';\nnV = CellGetN(sDyn, 'x');"` with `"sDyn = sOther;\nnV = CellGetN(sDyn, 'x');"`.
3. In the `buildReferenceIndex` integration test, replace `"sDyn = 'a' | 'b';\nExecuteProcess(sDyn);"` with `"sDyn = sOther;\nExecuteProcess(sDyn);"`. (The expected `unresolvedCallsBySourceProcess.get("p")` array — `line: 1`, `expr: "sDyn"`, `snippet: "ExecuteProcess(sDyn);"`, `reason: "dynamic"` — stays the same.)

- [ ] **Step 7: Flip the ripple fixture in `callgraph-unresolved-nodes.test.ts`**

In `indexWithDynamicCall`, replace the `Orchestrator` prolog `"ExecuteProcess('Child');\nsDyn = 'a' | 'b';\nExecuteProcess(sDyn);"` with `"ExecuteProcess('Child');\nsDyn = sOther;\nExecuteProcess(sDyn);"`. (The assertions — one `unresolvedCalls` entry with `reason: "dynamic"` downstream, undefined upstream — stay the same.)

- [ ] **Step 8: Run the ripple tests, then full verify**

Run: `npx vitest run tests/unit/callgraph-unresolved.test.ts tests/unit/callgraph-unresolved-nodes.test.ts tests/unit/variable-env-concat.test.ts`
Expected: PASS (all).
Run: `npm run verify`
Expected: green — the fold change plus the four fixture flips keep every existing assertion valid.

- [ ] **Step 9: Commit**

```bash
git add src/lib/callgraph/variableEnv.ts tests/unit/variable-env-concat.test.ts tests/unit/callgraph-unresolved.test.ts tests/unit/callgraph-unresolved-nodes.test.ts
git commit -m "feat(callgraph): fold constant string-concat targets in resolveExpression"
```

---

### Task 2: Docs

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `README.md` (regen if the callgraph tool note changed)

**Interfaces:** none.

- [ ] **Step 1: CHANGELOG entry**

Under `## [Unreleased]` → `### Added` (or `### Changed`) in `CHANGELOG.md`:

```markdown
- `tm1_analyze_callgraph` / `tm1_analyze_object_usage` now fold constant string
  concatenations when resolving TI variable targets, so `sProc = 'zA' | 'zB';
  ExecuteProcess(sProc)` resolves to a real edge (`zAzB`) instead of being flagged
  unresolvable. Concatenations with a runtime operand (parameter, `CellGet*`, …)
  remain unresolved.
```

- [ ] **Step 2: README regen**

Run: `npm run tools:update-readme`
(The tool descriptions are unchanged by this feature, so this is likely a no-op — run it to be safe.)

- [ ] **Step 3: Verify**

Run: `npm run verify`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(callgraph): document constant string-concat folding"
```

- [ ] **Step 5: Live validation (controller-run)**

Against `tm1-v12` and a v11 server (`tm1-test`), create a fixture exercising both paths, run callgraph, confirm, delete:

```
prolog:
  sConst = 'zP' | '01';
  ExecuteProcess(sConst);       # → resolved child edge "zP01"
  sDyn = pInput | 'x';          # pInput is a parameter
  ExecuteProcess(sDyn);         # → still in unresolvedCalls (reason 'param')

tm1_analyze_callgraph(start=<fixture>, direction=downstream)
  → child "zP01" present; unresolvedCalls contains the sDyn call only
tm1_delete_process(... confirm=<fixture>)
```

(The fixture needs a declared `pInput` String parameter via `tm1_upsert_process`'s `parameters`.)

---

## Notes for the executor

- **Why `sOther` for the flipped fixtures:** an unknown/unassigned identifier resolves to `dynamic` and has no `|`, so it is completely stable under the new folding — a durable "genuinely dynamic" stand-in for the old constant-concat example.
- **No schema/type/tool changes** — this is purely a resolution-logic improvement behind existing interfaces.
- **Recursion safety:** `resolveExpression` recurses only into concat operands, each of which has no top-level `|` (so it cannot re-enter the `parts.length >= 2` branch) — depth is bounded by the number of `|` in one expression.
