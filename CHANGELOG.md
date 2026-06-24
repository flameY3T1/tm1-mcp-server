# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CAM (Cognos Access Manager) login. Set `TM1_NAMESPACE` for namespace auth
  (sends `Authorization: CAMNamespace base64(user:password:namespace)`) or
  `TM1_CAM_PASSPORT` for a pre-obtained passport (sends
  `Authorization: CAMPassport <token>`, takes precedence and needs no
  user/password). Native TM1 auth stays the default when neither is set.

### Changed

- `.env` is now loaded from the package/repo root (the directory containing
  `dist/`) in addition to the current working directory. MCP clients spawn the
  server with their own cwd, so a repo `.env` was previously never found unless
  the client explicitly set the working directory; it now works out of the box.
  dotenv's v17 startup tips are also suppressed (`quiet`) so they cannot corrupt
  the JSON-RPC stream on the stdio transport.
- CI now runs ESLint (`npm run lint:eslint`) alongside the existing typecheck,
  flat-API, and annotation-coverage gates.

### Security

- `.env.example` no longer ships `TM1_SSL_REJECT_UNAUTHORIZED=false` as an active
  default. The line is commented out so the secure code default (`true`, full TLS
  verification) applies unless a user deliberately opts out for self-signed certs.

## [2.1.0] - 2026-06-15

### Added

- `tm1_search_code` gains a `groupBy` parameter (`'process'` | `'tab'`) that
  returns a sorted match-count aggregation instead of individual match lines.
  Answers "which process has the most X calls" in a tiny payload instead of
  dumping every matching line. Counts are complete (per-process/total caps and
  `maskSecrets` do not apply in this mode).
- `tm1_analyze_object_usage` gains a `mode` parameter (`'full'` | `'summary'`).
  `summary` aggregates per source — one row per process/rule with its
  `accessTypes`, `sections`, `funcNames`, and usage `count`, sorted by count —
  dropping snippets. Collapses hundreds of usages into a compact data-flow
  overview for heavily-referenced cubes/dimensions.
- `tm1_list_error_logs` gains a `groupBy='process'` parameter that returns an
  audit summary — per process `{count, firstSeen, lastSeen, spanDays, perDay}`,
  sorted by count desc — instead of listing every file. Answers "which
  processes fail regularly" in one call. Process name and timestamp are
  extracted heuristically from the filename; unparseable names bucket under
  `(unparsed)`. The full-mode `lastUpdated` column is now derived from the
  filename timestamp (v11 OData exposes no LastUpdated field).

### Security

- Host-file access for the `.pro` round-trip tools (`tm1_diff_process_with_file`,
  `tm1_validate_process_refs`, `tm1_export_process_to_pro`, `tm1_import_pro_file`,
  `tm1_install_pro_bundle`) is now gated behind the new `TM1_LOCAL_FILE_ROOT`
  environment variable and **disabled by default**. When unset, the `filePath` /
  `writeToFile` / `directory` parameters are rejected and the tools accept only
  inline `content`; when set, supplied paths must resolve within that root (no
  `..` traversal). Prevents arbitrary host file read/write (e.g.
  `/proc/self/environ`, which would leak credentials, or `~/.ssh`) from the
  default tool surface, including in the default readonly mode.

## [2.0.0] - 2026-06-13

First public release.

### Architecture

- Service-composition architecture: all TM1 REST calls go through a service
  under `src/tm1-client/services/`; the `lint:no-flat-api` CI gate prevents
  regression to flat-client calls.
- 109 MCP tools across 12 categories (metadata, model building, dimension
  management, subsets, views, cell data, TI development, TI lifecycle,
  process execution, scheduling, security, operations, analysis).
- Four read-only MCP resources (`tm1://server/info`, `tm1://server/state`,
  `tm1://process/{name}/code`, `tm1://cube/{name}/rules`) with name-autocomplete
  completion callbacks.

### Transports

- stdio transport (default) for local Claude Code / Claude Desktop.
- Streamable HTTP transport (stateless `POST /mcp`) with DNS-rebinding
  protection, `Host`/`Origin` validation, and configurable bind host/port/origins.

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
- `tm1_analyze_object_usage`, `tm1_analyze_chore_graph`,
  `tm1_invalidate_callgraph_cache`, `tm1_find_orphan_dimensions`,
  `tm1_check_v12_readiness`.

### TI lifecycle (.pro)

- `tm1_import_pro_file`, `tm1_diff_process_with_file`, `tm1_install_pro_bundle`,
  `tm1_export_process_to_pro`, `tm1_upsert_process`, `tm1_diff_processes`.

### Pre-write validation

- `tm1_check_process_code`, `tm1_check_cube_rule`, `tm1_validate_process_refs`,
  `tm1_check_writable_coords`.

### Cell data

- `tm1_execute_mdx` with `format=markdown` pivot/flat rendering.
- `tm1_search_code` with `deduplicateByLine`; `tm1_search_rules` regex search
  across cube rules.

### Reliability and performance

- Removed pretty-print JSON from tool output; gzip responses; method-aware
  timeout hints; parallel `writeCells`.
- Transaction-log query hardening: fail-fast preflight probe, Z-normalized
  `since` filter, and adaptive time-window backfill to avoid full-scan timeouts.
- TM1 security denials (HTTP 400) classified as `PERMISSION_DENIED`;
  HTTP transport distinguishes `LOCK_TIMEOUT` from `CONNECTION_FAILED`.
- Strict (`additionalProperties: false`) output schemas across tools.
- Secrets masked in tool output.

### Documentation

- README, ARCHITECTURE, CONTRIBUTING, and SECURITY policy for open-source release.

[Unreleased]: https://github.com/flameY3T1/tm1-mcp-server/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/flameY3T1/tm1-mcp-server/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/flameY3T1/tm1-mcp-server/releases/tag/v2.0.0
