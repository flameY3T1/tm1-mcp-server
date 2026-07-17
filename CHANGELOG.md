# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tm1_analyze_callgraph` now surfaces `ExecuteProcess`/`RunProcess` calls whose
  target is a computed expression or a process parameter as `unresolvedCalls`
  (full/compact modes) / `unresolvedCount` (summary) instead of silently dropping
  them. The call is flagged for manual review — not resolved (statically impossible).
- TM1 v12 (Planning Analytics Engine) connection support: URL rerooting under
  `/{instance}/api/v1/Databases('{database}')` and a `POST /{instance}/auth/v1/session`
  login. Auth modes: `s2s` (live-validated), `basic`/`access_token`/`oidc`/`iam`
  (unit-validated request builders, not yet live-validated).
- TM1 v12 (Planning Analytics Engine) Jobs/Activity monitoring: `tm1_list_jobs`
  and `tm1_cancel_job`. Monitoring tools are version-gated — v11 connections
  expose the thread tools, v12 connections expose the job tools.

### Fixed

- `tm1_get_server_info` now reports the correct product version on v12: v12
  omits `ProductVersion` from the `Configuration` body, so `getInfo()` falls
  back to the `/Configuration/ProductVersion` scalar.

### Changed

- **Breaking:** `tm1_export_process_to_git` / `tm1_import_process_from_git` now use
  TM1's native `#region <Tab>` / `#endregion` code format (the server `Code`
  property) instead of the previous `### TM1-TI-TAB:` markers. Exported `.ti`
  files are byte-identical to `GET /Processes('x')/Code/$value` (CRLF, empty
  tabs omitted). `.ti` files produced by earlier versions are no longer
  importable — re-export from the server to regenerate.

## [1.0.4] - 2026-07-12

### Security

- `tm1_get_all_processes_code` masks credential literals by default (new
  `maskSecrets` flag) — it was the only code-returning tool without masking.
- ODBC connection strings (`oDBCConnection`, `PWD=`/`UID=` pairs) are masked
  by default in `tm1_get_process`, `tm1_get_process_datasource` (new
  `maskSecrets` flag) and the git-export `.json`; previously only the
  `password` field was stripped.
- Local-file confinement (`TM1_LOCAL_FILE_ROOT`) is symlink-aware: targets are
  `realpath`-checked against the resolved root.
- HTTP transport refuses a non-loopback bind (`TM1_MCP_HTTP_HOST`) without
  `TM1_MCP_HTTP_TOKEN`; loopback stays warn-only.

### Added

- `tm1_get_all_processes_code` `summary` mode: per-process line metrics
  instead of code bodies.
- Every tool carries an auto-derived human-readable `title`
  (`tm1_get_process_code` → "Get Process Code").

### Fixed

- Output-schema drift returns an `isError` tool result instead of a raw
  JSON-RPC protocol error.
- `tm1_analyze_chore_graph` not-found warning conforms to the output schema
  again (was rejected by strict validation, so it never reached the client).
- Git/pro export create missing target directories instead of raw `ENOENT`.

### Changed

- **Breaking:** input params renamed for cross-tool consistency —
  `tm1_bulk_upsert_elements` `hierarchy` → `hierarchyName`; the chore family
  (`create/delete/execute/toggle/update_chore`, `analyze_chore_graph`) now
  uniformly takes `choreName` (was `name`; analyze was `chore`). MCP clients
  re-read schemas per session and pick the new names up automatically.
- `tm1_get_process` declares a strict `outputSchema` like its siblings.
- `tm1_get_descendants`: `topN` cap (default 1000) + `truncated` flag —
  no more full-dimension dumps from a root consolidation.
- `tm1_get_process` fetches its enabled sections in parallel (was up to 5
  sequential REST calls).
- Publishing runs a clean `prepack` (`rm -rf dist && npm run build`); release
  flow documented in `RELEASING.md`.
- `tm1_export_process_to_git` with `writeToDir` returns metadata only (no
  inline `json`/`ti` echo); inline export unchanged. Mirrors
  `tm1_import_process_from_git`.

## [1.0.3] - 2026-07-05

Audit + live-sweep release, plus the process `HasSecurityAccess` read-side and
a git-export format alignment. Bundles the 2026-07-03 "beyond the basics" audit
fixes (transport lifecycle, cellset leak, error honesty, confirm-guard
coverage) and tool gaps found while sweeping ~35 tools against a production
TM1 11.8 server; the read-side of `HasSecurityAccess` (the write path landed in
the same release); and the git-export `.json` moved to TM1's native OData
shape. Behavior changes are called out below.

### ⚠️ Behavior change

- `tm1_export_process_to_git` now emits the `.json` in TM1's OData-native
  shape: top-level order `name, hasSecurityAccess, dataSource, parameters,
  variables`, and parameter objects as `name, prompt, value, type`. The
  parameter default uses the OData-native key **`value`** (previously the
  internal name `defaultValue`). `tm1_import_process_from_git` reads `value`
  and still accepts legacy `defaultValue` files for back-compat. The change is
  confined to the git file format; the internal contract and
  `tm1_upsert_process` input remain `defaultValue`. JSON key order is cosmetic
  — import parses by key, so the round-trip is unaffected.

- The `confirm: true` guard now covers the **entire** object-destruction
  surface: `tm1_delete_element`, `tm1_delete_hierarchy`, `tm1_delete_subset`,
  `tm1_delete_view`, `tm1_delete_chore`, `tm1_delete_client`,
  `tm1_delete_file`, and `tm1_remove_client_group` join the previously guarded
  deletes. Calls without `confirm: true` are rejected with a hint (a unit test
  gates the tool set so new destructive tools cannot ship unguarded).
- `tm1_write_cells` reports partial failures honestly: `allSettled` semantics
  with `{ written, failed, notAttempted }` instead of failing the whole batch
  on the first bad cell.

### Added

- Git-process roundtrip carries `HasSecurityAccess`: `tm1_export_process_to_git`
  reads and emits it, `tm1_import_process_from_git` applies it (PATCH, only
  when declared in the file — existing server values are preserved otherwise),
  and `tm1_upsert_process` accepts it as an input field. `Caption` was
  evaluated and deliberately left out: TM1 offers no reliable write path
  (`}ElementAttributes_}Processes` is absent on attribute-less dimensions), so
  a lossy field is not pretended to be lossless.
- `tm1_get_process` — a native full read of a TI process, the read-twin of
  `tm1_upsert_process`. One call returns the four code tabs, parameters,
  variables, datasource, and the `HasSecurityAccess` flag using the same field
  names as `upsert_process`. Every part sits behind an include-flag (all
  default `true`) that gates its REST call, so a caller can skip parts it does
  not need; `maskSecrets` and `stripComments` mirror `tm1_get_process_code`.
  For git persistence use `tm1_export_process_to_git` instead — this tool is
  for reading/understanding a process, not serialization.
- `tm1_get_all_processes_code` now carries each process's `hasSecurityAccess`
  flag per row, so the audit bulk-load can answer which processes run elevated
  (previously the flag was readable only through the git export).
- `tm1_get_process_code` gains an opt-in `includeSecurityAccess` flag (default
  `false`, so pure code reads stay a single request); when `true` it adds the
  `hasSecurityAccess` field via a dedicated metadata GET.
- `tm1_validate_process_refs` now resolves much more of the real-world TI
  surface: `DIMIX`, `CellIncrementN`, `CellPutProportionalSpread`,
  `ViewZeroOut`, `CubeClearData`; cube/dimension args in position 2
  (`CellPutN/S`, `AttrPutN/S`, `ElementSecurityPut`) are extracted with a
  paren/quote walker that handles nested function calls, multi-line calls, and
  TI `''` escapes; and variable object names bound to a single literal
  (`sCube = 'Sales'; CellGetN(sCube, ...)`) resolve through the per-process
  variable environment. Params, datasource variables, and reassigned
  variables stay conservatively unresolved — no false positives.
- HTTP transport (Streamable) builds an isolated server+transport pair per
  request instead of sharing one across sessions.

### Fixed

- Read-path cellsets (`tm1_get_view`, `tm1_execute_mdx`, sampling) are freed
  on the server after use — long-lived sessions no longer leak TM1 memory.
- Service layer propagates systemic transport errors (auth loss, outages)
  instead of degrading them to empty results (`exists()` probes pinned to
  404-only, callgraph/audit tools fail loud on outage).
- `tm1_execute_process`: client-side aborts are reported as *unconfirmed*
  (with a list/cancel-thread hint) instead of pretending the process failed;
  TI failure status keeps the `isError` flag.
- Session manager: stale-cookie re-auth short-circuits the 401 storm when
  many parallel requests race; keep-alive no longer clears a fresh cookie.
- `tm1_check_process_code`: syntax errors return a self-describing
  `VALIDATION_ERROR` payload (short message + actionable hint) instead of a
  generic `TM1_ERROR` envelope with the whole payload duplicated into
  `message`; the isError normalizer no longer falls back to raw-JSON
  duplication for any tool.
- OData key segments with embedded quotes are escaped in the rules linter;
  `]` is escaped in attribute-value MDX.
- `TM1_MODE` parsing is case-insensitive and fails fast on unknown values
  (a typo no longer silently granted read-write).
- Crash exit: `uncaughtException` terminates with exit code 1 (was 0), so
  supervisors detect the failure.
- Element "already exists" detection pinned cross-version (v11 HTTP 400 vs
  409) with a unit test, keeping `tm1_bulk_upsert_elements` idempotent.
- Masking property tests exercise the real logger construction path (a fake
  copy had let redaction regressions slip); `Cookie` headers joined the
  redaction list.

## [1.0.2] - 2026-07-02

Hardening release: security, bounded outputs, robustness, and internal
layering. Two output-shape changes are noted below — they affect how a client
reads results, though in practice an MCP agent reads the envelope dynamically.

### ⚠️ Output-shape changes

- `tm1_get_view` now returns a paginated envelope
  (`{ items, total, count, offset, has_more, next_offset, axes }`) instead of a
  raw cellset, and paginates by default. Pass `fetchAll: true` (or `limit: 0`)
  for the full cellset. The cell array moved from `cells` to `items`.
- `tm1_resolve_default_member` was removed; use `tm1_resolve_default_members`
  with a single-item array (`items: [{ dimensionName }]`). The resolved member
  is `results[0].resolved.name` (content is identical to the old tool).

### Added

- `tm1_get_view`: `format='markdown'` pivot-grid/flat-table rendering plus
  `limit`/`offset`/`fetchAll` pagination (`$top`/`$skip` pushed server-side),
  reusing the `tm1_execute_mdx` envelope.
- `tm1_get_hierarchy`: default element cap with a `truncated` flag on cut output.
- Code-reading TI tools (`tm1_get_process_code`, `tm1_export_process_to_pro`,
  `tm1_export_process_to_git`, `tm1_diff_processes`, `tm1_diff_process_with_file`)
  gain a `maskSecrets` flag (default `true`) that masks inline ODBC/connection
  credentials before returning or writing code.
- outputSchema byte-budget CI gate (`lint:output-schema-budget`) guarding the
  tools/list payload against schema bloat; wired into `npm run verify` and CI.

### Changed

- Tool responses now emit compact JSON (disk artifacts stay pretty-printed),
  cutting every large response body.
- Trimmed verbose top-level tool descriptions that restated per-field docs.
- `TM1Client` uses composition over inheritance so the raw transport surface is
  no longer reachable from the tools layer (compiler-enforced, not just lint).

### Removed

- `tm1_resolve_default_member` (merged into `tm1_resolve_default_members`);
  tool count 112 → 111.

### Fixed

- Inline ODBC/connection-string credentials in TI code are now masked in the
  five code-reading tools (previously returned — and for git export, written to
  disk — in plaintext).
- Transaction-log windowing/probe paths no longer swallow connection outages or
  permission denials as an empty "no data in range" result.
- Network-error classification uses `err.cause.code` (undici) instead of brittle
  message-substring matching that varied by Node version and locale.
- `asOutputSchema` no longer reads Zod's private `_def`; uses the public
  accessor and pins Zod to an exact version with a regression test.

## [1.0.1] - 2026-06-30

### Added

- `tm1_trace_data_flow`: new analysis tool that traces a cube's data flow in one
  call instead of `analyze_object_usage` + N× `get_process_code`. `downstream`
  lists processes that read the cube and the cubes they write to; `upstream`
  lists processes that write the cube and where they source data. Combines
  code-level CellGet/CellPut/DB access with each process's datasource (one bulk
  OData fetch), so view-sourced reads with no CellGet are caught too.

- `tm1_get_message_log`: each entry now surfaces an optional `errorFile` field —
  the TI error filename parsed out of the message text — so it can be passed
  straight to `tm1_get_error_log_content` without manual string-copying.
- `tm1_sample_cells`: opt-in `includeStrings` flag to sample String value
  fields. Swaps NON EMPTY for a `<> ""` FILTER and scans all members including
  consolidations (string values do not roll up and can sit on C elements). A
  zero-result numeric run now hints at the flag.
- `tm1_get_process_code`: opt-in `stripComments` flag that collapses runs of 4+
  consecutive comment lines into a `# [... N lines commented out ...]` marker to
  reduce dead-code context. Comment-heavy tabs surface a hint when not stripped.

### Fixed

- Corrected the read/write access taxonomy behind `tm1_analyze_object_usage` and
  `tm1_trace_data_flow`. Now classified: element/dimension attribute value access
  (`AttrPutN/S`, `ElementAttrPutN/S` writes; `ATTRN/S`, `AttrNL/SL`,
  `ElementAttrN/S/NL/SL` reads) and cube attributes (`CubeAttrPutN/S` writes,
  `CubeATTRNL/SL` reads). Removed classification of functions that do not exist in
  TM1 TI — `CellIncrement` (only `CellIncrementN`), `CubePutN/S`, `ViewPutN/S`,
  `CubeGetN/S`, `ViewGetN/S`, `ViewAttr*`, base-form `CubeAttrN/S`, `AttributeGet`,
  `AttributePut` — so they are no longer mis-counted as reads/writes. The bogus
  `CellIncrement` TI signature was also dropped.

## [1.0.0] - 2026-06-24

Initial public release.

### Architecture

- Service-composition architecture: all TM1 REST calls go through a service
  under `src/tm1-client/services/`; the `lint:no-flat-api` CI gate prevents
  regression to flat-client calls.
- 111 MCP tools across 12 categories (metadata, model building, dimension
  management, subsets, views, cell data, TI development, TI lifecycle,
  process execution, scheduling, security, operations, analysis).
- Four read-only MCP resources (`tm1://server/info`, `tm1://server/state`,
  `tm1://process/{name}/code`, `tm1://cube/{name}/rules`) with name-autocomplete
  completion callbacks.

### Transports

- stdio transport (default) for local Claude Code / Claude Desktop.
- Streamable HTTP transport (stateless `POST /mcp`) with DNS-rebinding
  protection, `Host`/`Origin` validation, and configurable bind host/port/origins.

### Authentication

- Native TM1 auth (`TM1_USER` / `TM1_PASSWORD`) is the default.
- CAM (Cognos Access Manager) login. Set `TM1_NAMESPACE` for namespace auth
  (sends `Authorization: CAMNamespace base64(user:password:namespace)`) or
  `TM1_CAM_PASSPORT` for a pre-obtained passport (sends
  `Authorization: CAMPassport <token>`, takes precedence and needs no
  user/password).

### Modes

- `TM1_MODE=readonly` (default) restricts tool registration to non-destructive
  tools for production instances; `readwrite` opts in to the full lifecycle.

### TI analysis

- `tm1_analyze_callgraph` — ExecuteProcess/RunProcess call tree with parameter
  env propagation, `mode='summary'` aggregates, and global fan-out/fan-in
  ranking when `start` is omitted.
- `tm1_audit_feeders` — static overfeeding heuristics S1–S5 plus a runtime
  fed/populated-ratio metric (`}StatsByCube` evidence) calibrated to the
  TM1 community (≥50× hint, ≥100× evidence); runtime evidence escalates static
  findings.
- `tm1_audit_naming` — bulk-scan TM1 objects against IBM Planning Analytics
  naming conventions (PA 2.0 + 3.1).
- `tm1_audit_complexity` — TI/rule complexity metrics plus an opt-in
  antipatterns lint scope (cognitive-style scoreV2, dead-assignment rule).
- `tm1_analyze_object_usage` (with `mode='summary'` per-source aggregation),
  `tm1_analyze_chore_graph`, `tm1_invalidate_callgraph_cache`,
  `tm1_find_orphan_dimensions`, `tm1_check_v12_readiness`.

### TI lifecycle (.pro)

- `tm1_import_pro_file`, `tm1_diff_process_with_file`, `tm1_install_pro_bundle`,
  `tm1_export_process_to_pro`, `tm1_upsert_process`, `tm1_diff_processes`.

### Pre-write validation

- `tm1_check_process_code`, `tm1_check_cube_rule`, `tm1_validate_process_refs`,
  `tm1_check_writable_coords`.

### Cell data and search

- `tm1_execute_mdx` with `format=markdown` pivot/flat rendering.
- `tm1_search_code` with `deduplicateByLine` and a `groupBy` (`'process'` |
  `'tab'`) match-count aggregation mode; `tm1_search_rules` regex search across
  cube rules.
- `tm1_list_error_logs` with a `groupBy='process'` audit-summary mode
  (per process `{count, firstSeen, lastSeen, spanDays, perDay}`).

### Reliability and performance

- Removed pretty-print JSON from tool output; gzip responses; method-aware
  timeout hints; parallel `writeCells`.
- Transaction-log query hardening: fail-fast preflight probe, Z-normalized
  `since` filter, and adaptive time-window backfill to avoid full-scan timeouts.
- TM1 security denials (HTTP 400) classified as `PERMISSION_DENIED`;
  HTTP transport distinguishes `LOCK_TIMEOUT` from `CONNECTION_FAILED`.
- Strict (`additionalProperties: false`) output schemas across tools.
- Secrets masked in tool output.
- `.env` is loaded from the package/repo root (the directory containing `dist/`)
  in addition to the current working directory, so MCP clients that spawn the
  server with their own cwd still pick up a repo `.env`. dotenv v17 startup tips
  are suppressed (`quiet`) so they cannot corrupt the stdio JSON-RPC stream.

### Security

- Host-file access for the `.pro` round-trip tools (`tm1_diff_process_with_file`,
  `tm1_validate_process_refs`, `tm1_export_process_to_pro`, `tm1_import_pro_file`,
  `tm1_install_pro_bundle`) is gated behind the `TM1_LOCAL_FILE_ROOT` environment
  variable and **disabled by default**. When unset, the `filePath` / `writeToFile`
  / `directory` parameters are rejected and the tools accept only inline
  `content`; when set, supplied paths must resolve within that root (no `..`
  traversal).
- `.env.example` ships with TLS verification on: `TM1_SSL_REJECT_UNAUTHORIZED`
  is commented out so the secure code default (`true`) applies unless a user
  deliberately opts out for self-signed certs.

### Documentation

- README, ARCHITECTURE, CONTRIBUTING, and SECURITY policy for open-source release.

### CI

- Quality gates: strict typecheck, ESLint, `lint:no-flat-api`,
  annotation-coverage, and tool-registration wiring.

[Unreleased]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/flameY3T1/tm1-mcp-server/releases/tag/v1.0.0
