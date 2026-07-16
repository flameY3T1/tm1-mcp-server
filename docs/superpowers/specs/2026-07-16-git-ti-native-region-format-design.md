# Align git process export/import to IBM-native `#region` code format

**Date:** 2026-07-16
**Status:** Approved (design), pending implementation plan
**Scope:** `tm1_export_process_to_git` + `tm1_import_process_from_git` only

## Goal

Replace our home-grown `.ti` code-file convention (`### TM1-TI-TAB: prolog ###`
markers) with TM1's **native single-blob code representation** — the
`#region <Tab>` / `#endregion` format that the server itself emits and consumes
via the `Code` property. This makes our `.ti` files byte-identical to what TM1
produces, so they are readable/paste-able in the PAW process editor and align
with IBM's own tooling.

## Verified facts (live probes against tm1-test 11.x)

All confirmed empirically (throwaway processes, deleted after):

1. **`GET /api/v1/Processes('x')/Code/$value`** → `200`, `text/plain; charset=utf-8`.
   Returns the whole process code as one blob:
   ```
   #region Prolog
   <prolog code>
   #endregion
   #region Epilog
   <epilog code>
   #endregion
   ```
   - Marker keyword lowercase `#region` / `#endregion`; tab name **capitalized**
     (`Prolog`/`Metadata`/`Data`/`Epilog`).
   - **Empty tabs are omitted entirely** — only tabs with code get a region.
   - Newlines are **CRLF** (`\r\n`). No trailing newline after final `#endregion`.

2. **Write path — only JSON PATCH works:**
   - `PATCH /api/v1/Processes('x')` body `{"Code":"<#region blob>"}` → `200`.
     Server parses the region markers and distributes code into the four
     procedures. Verified: blob content landed in `PrologProcedure`, markers
     stripped.
   - `PUT .../Code/$value` (text/plain) → `400` "content type not supported".
   - `PUT .../Code/$value` (json) → `400` "PUT not supported on this resource!".
   - `PUT .../PrologProcedure/$value` → `400` "PUT not supported" — **`$value`
     is read-only** for both the combined and per-tab properties.

3. **Per-tab `$value` (`GET /PrologProcedure/$value`)** → `200`, raw `text/plain`,
   no region wrapper. Clean read but: read-only, 4 calls/process, no collection
   form. Rejected for git use (loses single-file format) and for the general
   read tools (kills `get_all_processes_code` batching). No fidelity advantage —
   JSON `$select` decodes to identical strings.

## Design decisions (locked)

| Decision | Choice |
|---|---|
| Transport | Combined `Code` property: read `GET /Code/$value`, write `PATCH {Code}` |
| Marker format | `#region <CapTab>` / `#endregion`, server-owned |
| Empty tabs | Omitted (IBM-native) |
| Newlines | **CRLF everywhere** — file on disk and wire, byte-identical to server |
| Back-compat | **Hard-cut** — old `### TM1-TI-TAB:` files no longer importable |
| `.json` sibling | Unchanged (params/vars/datasource/hasSecurityAccess) |
| Out of scope | `get_process`, `get_process_code`, `get_all_processes_code` stay on `$select` |

## Architecture

### Acceptance invariant
The exported `.ti` for a process **equals byte-for-byte** what
`GET /Processes('x')/Code/$value` returns (after masking). We do not
re-serialize the code locally — the server owns the `#region` syntax on both
ends. Our only local marker handling is the import-side parser used for
preflight, which is off the critical transport path.

### Transport layer — `src/tm1-client/services/process-service.ts`
Two new methods:
- `getCodeBlob(name): Promise<string>` — `GET /Processes('<name>')/Code/$value`,
  read raw `text/plain` (the HTTP client currently only decodes JSON; add a
  raw-text GET path).
- `updateCodeBlob(name, blob): Promise<void>` — `PATCH /Processes('<name>')`
  with `{ Code: blob }`.

Existing `getCode` (4-field `$select`) and `updateCode` (4-field PATCH) **stay** —
`get_process` and `upsert_process` continue to use them.

### Export — `src/tools/ti-development/export-process-to-git.ts`
- `.ti` = `maskCode(getCodeBlob(name))` — the server blob directly, masked.
  No local `#region` generation.
- `.json` = built from params/vars/datasource/meta as today.
- `serializeProcessToGit` reduced to building the `.json` only (drop its `.ti`
  generation).

### Import — `src/tools/ti-development/import-process-from-git.ts`
- `parseProcessFromGit(json, ti)` rewritten to read the `#region` blob:
  - Split on `#region <tab>` … `#endregion`; keyword + tab name matched
    **case-insensitively** against the four known tabs.
  - Missing region → that tab is `""`.
  - **Zero regions found → throw** (hard-cut; rejects old `### TM1-TI-TAB:`
    files with a clear message).
  - Returns the four tabs (for preflight) plus params/vars/ds from `.json`.
- Preflight (`check()`) unchanged — consumes the four parsed tabs.
- **Write code via `updateCodeBlob(name, ti)`** — send the raw CRLF blob as
  `{Code}`, letting the server split it, instead of four separate field PATCHes.
- Params/vars/datasource/hasSecurityAccess writes unchanged.

## Error handling
- Import on a non-`#region` file → `VALIDATION_ERROR` with a message naming the
  expected `#region` markers and pointing at the format change.
- `getCodeBlob` non-200 / non-text → surfaced as a normal TM1 client error.
- Partial-apply hints on `updateCodeBlob` mirror the existing `updateCode` hint.

## Open verification items
1. **Empty-tab clearing — RESOLVED (verified 2026-07-16, favorable):**
   `PATCH {Code}` is a **full replace** of all four tabs from the blob. A blob
   with only `#region Prolog` cleared Metadata/Data/Epilog to `""`. So import
   sends the blob as-is and omitted regions are blanked by the server — no
   explicit blanking needed, and `mode=update` round-trips empty tabs correctly.

Remaining (test during implementation):
2. **`Code/$value` availability** across supported TM1 versions (v11 baseline
   confirmed; note v12 behaviour if reachable).
3. **Round-trip byte-identity:** export → compare `.ti` to `GET /Code/$value`;
   import the same `.ti` back → re-export → identical.

## Testing
- **Unit** (`git-process` serialize/parse):
  - parse `#region` blob → correct 4 tabs; capitalized + lowercase tab names;
    missing region → empty tab; zero regions → throws.
  - `.json` builder unchanged (regression guard).
  - old `### TM1-TI-TAB:` input → throws (hard-cut).
- **Live** (integration suite):
  - export `.ti` byte-identical to `/Code/$value`.
  - export → import round-trip on a multi-tab process.
  - empty-tab process round-trip (verification item 1).

## Migration / BREAKING
- `.ti` files produced by prior versions (`### TM1-TI-TAB:` markers) are **no
  longer importable**. Document as BREAKING in CHANGELOG; re-export from the
  server to regenerate.
- Fix the overclaiming line in `export_process_to_git`'s description
  ("the diff-friendly format TM1's native Git integration and TM1py use") — it
  is inaccurate. Replace with an accurate statement: the `.ti` mirrors TM1's
  native `Code` representation (`#region`/`#endregion`), `.json` carries the
  structure.

## Files touched
- `src/tm1-client/services/process-service.ts` — `getCodeBlob`, `updateCodeBlob`, raw-text GET.
- `src/lib/git-process.ts` — parser rewrite; serialize reduced to `.json`.
- `src/tools/ti-development/export-process-to-git.ts` — source `.ti` from blob; description fix.
- `src/tools/ti-development/import-process-from-git.ts` — blob write path.
- Tests: unit for git-process, live for export/import.
- `CHANGELOG.md` — BREAKING entry.
