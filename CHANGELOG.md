# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Security

- Ignore `.npmrc` to prevent accidental npm token commits.

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

[Unreleased]: https://github.com/flameY3T1/tm1-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/flameY3T1/tm1-mcp-server/releases/tag/v1.0.0
