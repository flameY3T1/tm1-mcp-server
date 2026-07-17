# Constant string-concat folding — design spec

**Date:** 2026-07-17
**Status:** approved, ready for implementation plan
**Related:** builds on `2026-07-17-callgraph-unresolved-calls-design.md` (the unresolvedCalls marker) — this reduces how often that marker fires.

## Problem

TI variable resolution (`src/lib/callgraph/variableEnv.ts` `resolveExpression`) classifies
any expression containing the `|` string-concatenation operator as `dynamic` — even when
every operand is a constant. So `sProc = 'zStep' | '01'; ExecuteProcess(sProc)` is treated
as unresolvable, when it is statically the literal `zStep01`.

Consequence: constant-concatenation call/reference targets are either dropped or (after the
unresolvedCalls feature) flagged `unresolvedCalls` — a false "can't resolve" when the value
is in fact statically determinable. This under-reports real edges in `tm1_analyze_callgraph`
and real cube/dimension usages in `tm1_analyze_object_usage`, whenever a model builds object
names by concatenating literals (a common TI pattern: `'z' | sModule | '_load'`).

## Solution

Fold constant `|`-concatenations in `resolveExpression`: when an expression is a
concatenation whose every operand resolves to a literal, return the concatenated literal
value. When any operand is non-literal (parameter, DataSource var, `CellGet*`, function
call, arithmetic, another dynamic var), it stays `dynamic` — unchanged.

Because `resolveExpression` is the single chokepoint used by both `buildProcessEnv`
(variable-env building) and `referenceIndex` (callee, cube, dimension, and param
resolution), the fix improves callgraph edges, object-usage attribution, and shrinks
`unresolvedCalls` — all at once, with no per-consumer change.

**Explicitly not resolving** (stays `dynamic`, correct): runtime values. A `param|'x'`
concatenation depends on the caller; a `CellGetS(...)|'y'` depends on data. These are not
statically knowable and must remain flagged.

## Component

### `resolveExpression` (`src/lib/callgraph/variableEnv.ts`)

Current order: string-literal → numeric-literal → bare-identifier (param/DS/var lookup) →
`dynamic`. Insert a concat-folding branch **before the final `dynamic` return** (and after
the bare-identifier branch, so a lone identifier is still a var lookup, not a 1-part
"concat"):

1. **Quote/paren-aware split** of the trimmed expression on top-level `|`:
   iterate characters tracking `inString` (toggled by single-quote `'`) and paren depth;
   split on `|` only when `!inString && depth === 0`. A `|` inside a string literal
   (`'a|b'`) or inside parens (`SUBST(x|y)`) is not a split point.
2. If the split yields **fewer than 2 parts**, it is not a concatenation → fall through to
   the existing `dynamic` return (no behavior change for non-concat expressions).
3. Resolve each part with `resolveExpression(part.trim(), env)` (recursive; empty parts →
   dynamic, guarding malformed input like `'a' | | 'b'`).
4. If **every** part is `{kind:'literal'}` → return `{kind:'literal', value: parts.map(p => p.value).join('')}`.
5. Otherwise → return `{kind:'dynamic'}`.

**Transitivity** is automatic: `buildProcessEnv` processes assignments top-down and stores
each resolved binding in `env.vars`, so `sA = 'Cur' | 'Sales'` binds `sA`→literal `CurSales`,
and a later `sB = sA | 'Cube'` resolves `sA` (via the identifier branch → its stored literal)
then folds → `CurSalesCube`.

No new type, no signature change, no schema change — `VarBinding` already has `literal` and
`dynamic`.

## Behavior examples

| Expression | Before | After |
|---|---|---|
| `'te' \| 'st'` | dynamic | literal `test` |
| `'z' \| 'Step' \| '01'` | dynamic | literal `zStep01` |
| `sA \| 'x'` (sA bound to literal `'foo'`) | dynamic | literal `foox` |
| `'a\|b'` (pipe inside string) | literal `a\|b` | literal `a\|b` (unchanged) |
| `pInput \| 'x'` (pInput is a param) | dynamic | dynamic (unchanged) |
| `CellGetS('c','e') \| 'x'` | dynamic | dynamic (unchanged) |
| `'a' \| \| 'b'` (malformed) | dynamic | dynamic |

## Cross-feature ripple (must handle)

The just-merged `callgraph-unresolved-calls` tests use `'te' | 'st'` as their **dynamic
example**. After folding, that expression resolves to a literal, so those assertions flip:

- `tests/unit/callgraph-unresolved.test.ts` — the "records a dynamic (concatenated)
  ExecuteProcess target" and the buildReferenceIndex integration test currently assert
  `'te'|'st'` produces an unresolved call. They must switch to a **genuinely-dynamic**
  fixture — e.g. `sDyn = pInput | 'st'` with `pInput` a declared parameter (→ `reason:'param'`),
  or a `CellGetS(...)`-derived value (→ `reason:'dynamic'`).
- `tests/unit/callgraph-unresolved-nodes.test.ts` — same fixture flip.

These updates are part of this work (not a regression to fix later): the tests encode the
*old* classification of constant concat, which this feature deliberately changes.

## Testing

**Unit — `resolveExpression` (new `tests/unit/variable-env-concat.test.ts`):**
- `'te'|'st'` → literal `test`; `'z'|'Step'|'01'` → literal `zStep01`.
- var-chain: env with `sA`→literal, `sA|'x'` → literal.
- param operand → dynamic; `CellGetS` operand → dynamic.
- pipe-inside-string `'a|b'` → literal `a|b` (not split); `SUBST('x|y', ...)` style paren-guard.
- malformed `'a'||'b'` → dynamic.

**Unit — integration:** in `buildReferenceIndex`, `sProc = 'zA' | 'zB'; ExecuteProcess(sProc)`
→ a resolved process edge to `zAzB`, and **not** present in `unresolvedCallsBySourceProcess`.

**Update** the two flipped `callgraph-unresolved*` test files to genuinely-dynamic fixtures.

**Live (v12 + v11):** a fixture with both `sConst = 'zP'|'01'; ExecuteProcess(sConst)`
(→ resolved edge `zP01`) and `sDyn = pP | 'x'; ExecuteProcess(sDyn)` (→ still unresolved).
Delete after.

**Docs:** README (regen — tool behavior note) + `CHANGELOG.md` `[Unreleased]`.

## Out of scope

- `NumberToString`/`NumberToStringEx` folding, `%var%` parameter expansion, `SUBST`, arithmetic
  — only the literal `|` concat is folded.
- Constant-folding in cube-rules expressions (`DB('a'|'b',...)`) — the rules extractor
  (`extractRulesReferences`) is a separate path that does not use `resolveExpression`; unchanged.
