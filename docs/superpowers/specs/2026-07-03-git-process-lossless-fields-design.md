# Design: Lossless git-process roundtrip (HasSecurityAccess + Caption)

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation plan
**Area:** `tm1_export_process_to_git` / `tm1_import_process_from_git`

## Problem

The tm1-git two-file serializer (`src/lib/git-process.ts`) captures a TI
process as `{name}.json` (name, parameters, variables, dataSource) plus
`{name}.ti` (four code tabs). Round-trip is lossless **only for the fields it
knows**. Two fields TM1 exposes on the `Process` entity are silently dropped:

- **`HasSecurityAccess`** — functional. A process authored to run with elevated
  security access loses that flag on export→import and afterwards runs without
  elevation. Silent behaviour change.
- **`Attributes.Caption`** — the display alias shown in Architect/PAW. Cosmetic,
  but part of the entity.

Ground truth was taken live from the test server (`GET /api/v1/$metadata` +
`GET /api/v1/Processes('...')`). The full v11 `Process` EntityType is:

```
Name, HasSecurityAccess, PrologProcedure, MetadataProcedure, DataProcedure,
EpilogProcedure, DataSource, Parameters, Variables, Attributes
  + navigation: LocalizedAttributes, ErrorLogs
```

This server's `Process` type has **no** `UIData` / `VariablesUIData` property, so
those are out of scope (they are not part of the standard on this version).
`LocalizedAttributes` (locale-specific captions) and `ErrorLogs` (runtime) are
navigation properties, not part of a process *definition*, and are excluded.

Sub-shapes confirmed live:
- Parameter: `{Name, Prompt, Value, Type}` — already fully read by `getParameters`.
- Variable: `{Name, Type, Position, StartByte, EndByte}` — already fully read.
- DataSource: mixed casing (`Type` PascalCase, `view`/`dataSourceNameFor*` camel),
  already handled; `password` deliberately stripped and re-supplied on import.

**Net gap: `HasSecurityAccess` and `Caption` only.**

## Decision

Keep the readable two-file split format (the whole reason it exists — reviewable
git diffs). Do **not** switch to TM1's native single-JSON entity layout. Add the
two missing fields so the round-trip carries every field TM1 has. The format
stays our own documented convention, not byte-identical to TM1py / native git.

(Alternatives considered and rejected: (B) byte-faithful single-JSON entity —
kills diff readability, drops the `.ti` split and its tests; (C) dual-mode
export — more surface than the use-case justifies. User chose lossless+readable.)

## Changes

### 1. Export read — `src/tm1-client/services/process-service.ts`
Add `getDeployMeta(processName)` returning `{ hasSecurityAccess: boolean;
caption?: string }` via a single `GET /api/v1/Processes('{name}')
?$select=HasSecurityAccess,Attributes`. Map `Attributes.Caption` -> `caption`
(omit when empty or equal to the process name — TM1 defaults Caption to Name).

`export-process-to-git.ts` adds this to its existing `Promise.all([...])`.

### 2. Serializer — `src/lib/git-process.ts`
`GitProcessInput` and `ParsedGitProcess` gain `hasSecurityAccess: boolean` and
`caption?: string`. `serializeProcessToGit` writes them into the `.json` object
(top-level, camelCase, to match existing convention):

```json
{ "name": "...", "hasSecurityAccess": true, "caption": "...",
  "parameters": [], "variables": [], "dataSource": {} }
```

`caption` is omitted when absent. Field order places the two new keys after
`name` for readability.

### 3. Parser + schema — `src/lib/git-process.ts`, `src/lib/process-parts-schema.ts`
`parseProcessFromGit` reads `hasSecurityAccess` (default `false`) and `caption`
(optional). **Backward compatibility:** existing `.json` files lacking these keys
parse cleanly to the defaults — no breakage. Validation mirrors the existing
Zod-validated approach (add a small `z.boolean().default(false)` /
`z.string().optional()` where the metadata is parsed).

### 4. Import apply — `src/tools/ti-development/import-process-from-git.ts`
- **`HasSecurityAccess`**: set via `PATCH /api/v1/Processes('{name}')` with
  `{ HasSecurityAccess }`. Fold into the existing `updateCode` PATCH (add a
  `processes.updateSecurityAccess` or extend `updateCode` to accept it) so it is
  a single round trip with the code tabs. Well-known, safe.
- **`Caption`**: **best-effort**. Attempt to set it; if TM1 rejects (Attributes
  is a derived property, write path unverified), catch, log a warning, and
  continue — the import must not fail on Caption. Only applied when `caption`
  is present in the parsed JSON.

### 5. Output surface
`export` result JSON gains `hasSecurityAccess` and (when present) `caption` in
its summary. Add both to the tool's strict output schema in `src/tools/schemas/`
(SDK rejects unknown fields — `additionalProperties:false`). `import` result
summary gains `hasSecurityAccess` and a `captionApplied: boolean` flag so a
rejected best-effort Caption is visible.

## Risks / validation

- **Caption write path — confirmed empirically (2026-07-03, live test server).**
  `tm1_import_process_from_git`'s best-effort Caption apply
  (`ElementService.updateAttributeValue("}Processes", processName, "Caption",
  ...)`) was exercised against the real TM1 test server via
  `tests/live/process.live.test.ts` ("git export->import roundtrip preserves
  hasSecurityAccess and reports caption best-effort"). Result: the write is
  **rejected**, not accepted — the underlying `CellService.writeCells` call
  against the `}ElementAttributes_}Processes` control cube fails with an
  OData 400 (`ExecuteMDX` syntax error near the literal
  `[}ElementAttributes_}Processes]`), i.e. the control-cube name itself
  (containing a nested `}`) isn't accepted by the MDX-building path used
  under the hood. The tool correctly swallows this into
  `captionApplied: false` and the import still succeeds — HasSecurityAccess
  and all other fields are applied and the process is fully usable. Caption
  is therefore a confirmed **known cosmetic gap**: exported/re-imported
  processes never actually get their Caption set via this path, but nothing
  breaks. Best-effort framing did its job — the failure mode is non-fatal.
  Fixing the underlying control-cube MDX/write path is out of scope for this
  change; tracked as a follow-up if Caption fidelity is ever required.
- **HasSecurityAccess** write is a plain PATCH — confirmed live: set via
  `tm1_upsert_process({ hasSecurityAccess: true })`, survives export, a
  same-name re-import, retargeted import to a second process name, and a
  second re-export. Low risk, fully verified.

## Testing

- Extend `tests/unit/git-process-roundtrip.test.ts`: serialize->parse preserves
  `hasSecurityAccess` (true/false) and `caption`; old-format JSON (missing keys)
  parses to defaults.
- Live (`tests/live/...`): create a sandbox process with `HasSecurityAccess=true`
  and a Caption, export -> import into a second name, re-GET the entity, assert
  both fields survived. Reuse the SANDBOX-prefixed harness pattern.
- `npm run verify` (typecheck strict + lint gates + tests) must stay green;
  regenerate README if tool descriptions change (`npm run tools:update-readme`).

## Out of scope

`UIData`/`VariablesUIData` (absent on this TM1 version), `LocalizedAttributes`,
`ErrorLogs`, ODBC `password` (deliberately never serialized), and any switch to
the native single-JSON entity layout.
