# Design: Readable HasSecurityAccess + native full-process read

**Date:** 2026-07-05
**Status:** Approved (pending spec review)

## Problem

`tm1_upsert_process` can write every part of a TI process, including the
`hasSecurityAccess` flag (functional elevation). The read side is asymmetric:

1. **No inline way to read `HasSecurityAccess`.** The service method
   `getDeployMeta()` exists and returns it via a cheap
   `GET Processes('{name}')?$select=HasSecurityAccess`, but no tool exposes it.
   The only tool that surfaces the flag is `tm1_export_process_to_git` — a
   git-serializer (LF-normalized, `json`+`ti` two-file layout, password-stripped,
   masked). Using it to answer "does this process run elevated?" is misuse: it is
   built for git persistence, not for an LLM to read/understand a process.

2. **The audit bulk-load is blind to elevation.** `tm1_get_all_processes_code`
   (`$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure`)
   is explicitly the audit use-case tool, yet cannot answer "which processes run
   elevated?" — a core audit question.

3. **No purpose-built full read.** To assemble a complete process an agent must
   call up to four separate getters (code / parameters / variables / datasource)
   and still cannot get the security flag inline. There is no native read-twin of
   `upsert_process`.

## Goals

- Expose `HasSecurityAccess` where it is actually useful: bulk audit, a full
  native read, and (opt-in) alongside code.
- Provide a native, purpose-built full-process read that mirrors
  `upsert_process` field-for-field.
- Reuse existing service methods; add no new REST plumbing.

## Non-goals

- Replacing the granular getters (`get_process_parameters`/`_variables`/`_datasource`)
  — kept for token-narrow reads.
- Changing `export_process_to_git` — it stays a git serializer only.
- Caption round-trip — out of scope (dropped in both this server and TM1py;
  processes carry Caption only via the `}ElementAttributes_}Processes` control cube).

## Changes

### A. `tm1_get_all_processes_code` — add elevation to bulk audit

- `ProcessService.getAllCode()` (`src/tm1-client/services/process-service.ts:324`):
  add `HasSecurityAccess` to the `$select`; map it onto each row.
- Return type becomes `Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>`.
- Tool handler unchanged in shape — the field flows into each `processes[]` entry.
- No output-schema gate (this tool registers no `outputSchema`).
- Cost: one extra `$select` column on the same query. Effectively free.

### B. New tool `tm1_get_process` — native full read (read-twin of upsert)

- **Location:** `src/tools/ti-development/get-process.ts`.
- **Input:**
  - `processName: string`
  - `includeCode: boolean = true`
  - `includeParameters: boolean = true`
  - `includeVariables: boolean = true`
  - `includeDataSource: boolean = true`
  - `includeSecurityAccess: boolean = true`
  - `maskSecrets: boolean = true` (as in `get_process_code`)
  - `stripComments: boolean = false` (as in `get_process_code`; applies to code tabs)
- **Behaviour:** orchestrate only the flagged existing service methods —
  `getCode` / `getParameters` / `getVariables` / `getDataSource` / `getDeployMeta`.
  A flag set to `false` skips its REST call entirely (efficiency win).
- **Output shape:** mirrors `upsert_process` field names —
  `{ name, prolog?, metadata?, data?, epilog?, parameters?, variables?, dataSource?, hasSecurityAccess?, hint? }`.
  Omitted parts are absent (not null). This makes `get_process` ↔ `upsert_process`
  a genuine native round-trip pair.
- `maskSecrets` masks code tabs (via `maskCode`) and the datasource password.
  `stripComments` collapses 4+ comment-line runs in code tabs (reuse
  `stripCommentBlocks`), same `hint` behaviour as `get_process_code`.
- **No `outputSchema`** — follows sibling read-tool pattern (open payload).
- **Wiring:** `registerGetProcess` imported in `src/tools/index.ts` + added to
  `REGISTRARS`; `annotation-map.ts`: `tm1_get_process: READ_ONLY`.

### C. `tm1_get_process_code` — opt-in elevation alongside code

- Add `includeSecurityAccess: boolean = false` (default **false** — pure code
  reads stay a single GET, backward-compatible).
- When `true`: one extra `getDeployMeta` call; add `hasSecurityAccess` to payload.
- **Deliberate duplication** with B: `get_process_code` = lean code path,
  `get_process` = full entity. The flag having two homes is accepted; cost is one
  boolean and one reused service call.

## Cross-cutting

- **Tests (unit):** `getAllCode` includes the new `$select` column and maps the
  flag; `get_process` orchestration honours each include-flag (skips the
  corresponding service call when false) and mirrors upsert field names;
  `get_process_code` opt-in adds the flag only when requested.
- **Tests (live):** validate all three against a real TM1 — bulk row carries
  `hasSecurityAccess`; `get_process` returns full shape and respects flags;
  `get_process_code` opt-in surfaces the flag. A process known to run elevated is
  asserted `true`; a normal one `false`.
- **Docs:** `npm run tools:update-readme` (new tool). Note the read/write symmetry
  (`get_process` ↔ `upsert_process`) and that `export_process_to_git` remains
  git-only.
- **Gate:** `npm run verify` (typecheck strict + lint:no-flat-api +
  lint:annotations + lint:tool-registration + tests).

## Risks / trade-offs

- **`get_process` worst case = up to 5 sequential REST calls** (all flags on).
  Acceptable for v1: reuses battle-tested service methods and matches the
  codebase's per-part pattern. A future optimization could fold procedures +
  Parameters + Variables + DataSource + HasSecurityAccess into a single
  `$select` GET (TM1py-style), but that needs a new service method and TM1 v11
  `$select`-on-complex-type validation — deferred, not needed to close the gaps.
- **Flag duplication (B and C):** accepted per above; two small code paths reading
  `getDeployMeta`.
