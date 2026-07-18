# tm1-mcp-server

Model Context Protocol (MCP) server for IBM Planning Analytics / TM1.
Exposes the full TM1 model lifecycle — metadata, dimensions, cubes, cell I/O,
TI processes, chores, security, and code-graph analysis — to any MCP-compatible
LLM client (Claude Code, Claude Desktop, etc.).

Tested against TM1 11.8 via REST API (Basic Auth).

## Features

114 tools across 12 categories:

| Category | Tools |
|---|---|
| Metadata | list cubes / dimensions / processes / chores, get hierarchy |
| Model Building | create/delete/clear/unload cube, get/update/check cube rules, bulk get all rules |
| Dimension Management | dim + hierarchy CRUD, element CRUD, bulk upsert, attribute CRUD |
| Subsets | list/get/create/update/delete subsets |
| Views | list / create MDX view / delete view |
| Cell Data | execute MDX (+ `format=markdown` pivot render), get view, get cell value, write cells, **pre-write coord check** (N-Level + rule-overlap warn) |
| TI Development | process CRUD, compile, **unbound check** (pre-save validation), get/update code (single + bulk), datasource, variables, parameters, **regex search across all TI**, **upsert (atomic-style bundle)**, **ref validation** (cube/dim resolve) |
| TI Lifecycle (.pro + git) | **import .pro file** (parse + 1-call deploy), **diff installed vs .pro**, **install bundle** (directory of .pro files), **git export/import** (diff-friendly `{name}.json` + `{name}.ti` two-file layout, tm1-git/TM1py style; inline or host-disk paths — see [Local file access](#local-file-access-tm1_local_file_root)) |
| Process Execution | execute process, get parameters |
| Scheduling | chore CRUD, execute, toggle |
| Security | client + group CRUD, group assignment |
| Operations | server info, message log, transaction log, threads, sessions, file ops |
| Analysis | callgraph (full + summary mode + global ranking), object usage, chore graph, cache invalidation |

## Install

**Option A — from npm (recommended).** No clone, no build. Run on demand with
`npx` (always pulls the latest published version):

```bash
npx -y tm1-mcp-server
```

…or install the `tm1-mcp-server` CLI globally:

```bash
npm install -g tm1-mcp-server
tm1-mcp-server
```

**Option B — clone and build** (source / development install):

```bash
git clone https://github.com/flameY3T1/tm1-mcp-server.git
cd tm1-mcp-server
npm install
npm run build
node dist/index.js
```

### Updating

- **`npx`:** picks up new versions automatically on the next start. If a stale
  version is cached, run `npm cache clean --force` (or pin a version with
  `tm1-mcp-server@1.2.3`), then restart your MCP client.
- **Global install:** `npm update -g tm1-mcp-server` (or
  `npm install -g tm1-mcp-server@latest`); check with
  `npm view tm1-mcp-server version` vs `npm list -g tm1-mcp-server`.
- **Source install:** `git pull && npm install && npm run build`.

Always **restart the MCP client** (Claude Desktop / Claude Code) after updating —
the server process is only spawned at client startup.

## Configure

Copy `.env.example` to `.env` and set TM1 connection details:

```env
TM1_BASE_URL=https://your-tm1-server:8010
TM1_USER=admin
TM1_PASSWORD=your-password
TM1_SSL_REJECT_UNAUTHORIZED=false
TM1_VERSION=11.8
TM1_MODE=readonly                   # readonly (default) | readwrite
# TM1_LOCAL_FILE_ROOT=/srv/tm1-git  # optional; enables host-disk file params (see below)
```

For **CAM (Cognos Access Manager) / LDAP** servers, set `TM1_NAMESPACE` to your
CAM namespace (the client then logs in with `Authorization: CAMNamespace`); or
supply a pre-obtained passport via `TM1_CAM_PASSPORT` (`Authorization:
CAMPassport`, no user/password needed). Native TM1 auth stays the default when
neither is set.

See [`.env.example`](.env.example) for the full set (CAM auth, timeouts, logging, HTTP transport).

> **Safe by default:** the server starts in `TM1_MODE=readonly` — only read
> tools are registered, so it cannot mutate or delete anything. To enable the
> full lifecycle (cell writes, cube/dimension/process deletion, TI execution),
> set `TM1_MODE=readwrite` explicitly. Never point a `readwrite` server at a
> production instance without reviewing the write path first.

### Local file access (`TM1_LOCAL_FILE_ROOT`)

Tools that read or write files on the host running the server — `tm1_import_pro_file`,
`tm1_install_pro_bundle`, `tm1_diff_process_with_file`, `tm1_validate_process_refs`,
and the git export/import pair — are **disabled by default**. Set
`TM1_LOCAL_FILE_ROOT` to an absolute directory to enable host-path parameters;
every supplied path must resolve inside that root (path traversal is rejected).

```env
TM1_LOCAL_FILE_ROOT=/srv/tm1-git    # optional; enables host-disk file params
```

The git tools work without it via inline content:

- `tm1_export_process_to_git` returns `{name}.json` + `{name}.ti` inline by
  default; pass `writeToDir` (a host path under the root) to also persist them.
- `tm1_import_process_from_git` accepts `jsonContent`/`tiContent` strings, or
  `jsonPath`/`tiPath` host paths when the root is set.

The roundtrip is lossless for code, parameters, variables, datasource, and
`HasSecurityAccess` (exported to the JSON file, applied on import only when
declared there — otherwise the server value is preserved; also settable via
`tm1_upsert_process`). `Caption` is intentionally not roundtripped: TM1 exposes
no reliable write path for it.

The `.ti` file holds the four code tabs in TM1's **native `#region <Tab>` /
`#endregion` format** (the server `Code` property) — byte-identical to
`GET /Processes('x')/Code/$value` (CRLF, empty tabs omitted); nested user folding
regions inside a tab are preserved. A malformed/unbalanced blob is rejected on
import with a clear error rather than deployed partially. **Breaking (since the
previous `### TM1-TI-TAB:` format):** `.ti` files exported by earlier versions are
no longer importable — re-export from the server to regenerate.

### TM1 v12 (Planning Analytics Engine)

Setting `TM1_INSTANCE` + `TM1_DATABASE` auto-selects v12: requests are rerooted
to `/{instance}/api/v1/Databases('{database}')/...` and login goes through
`POST /{instance}/auth/v1/session` instead of the v11 `/api/v1/ActiveSession`
flow. For v12, `TM1_BASE_URL` is address:port only (no path) — e.g.
`https://your-pae-host:443`.

```env
TM1_INSTANCE=my-instance
TM1_DATABASE=my-database
TM1_AUTH_MODE=s2s                   # s2s (default) | basic | access_token | oidc | iam
TM1_USER=admin                      # supplies the session login "User" in every mode
```

`TM1_AUTH_MODE` selects how the `auth/v1/session` request authenticates, each
with its own env vars:

| Mode            | Vars                                 | Validation status                     |
| --------------- | ------------------------------------- | -------------------------------------- |
| `s2s` (default) | `TM1_CLIENT_ID`, `TM1_CLIENT_SECRET`  | **Live-validated** against PAE 12.5.9  |
| `basic`         | `TM1_USER`, `TM1_PASSWORD`            | Unit-validated request builder only    |
| `access_token`  | `TM1_ACCESS_TOKEN`                    | Unit-validated request builder only    |
| `oidc`          | `TM1_ACCESS_TOKEN`                    | Unit-validated request builder only    |
| `iam`           | `TM1_API_KEY`, `TM1_IAM_URL`          | Unit-validated request builder only    |

> Only `s2s` has been exercised against a live PAE server. The other modes'
> request builders are covered by unit tests but not yet confirmed against a
> real server — verify against your environment before relying on them.

## Use with Claude Code

Credentials live in `.env` (loaded at startup from the repo root — the directory
containing `dist/` — so it is found no matter which working directory the MCP
client launches the server from). The MCP client config only points at the
binary — **do not put `TM1_PASSWORD` in `.mcp.json` or `settings.json`**.

Copy `mcp.json.example` to `.mcp.json` (project-local) or merge into
`~/.claude/settings.json`.

**Recommended — `npx` (Option A install, no clone):**

```json
{
  "mcpServers": {
    "tm1": {
      "command": "npx",
      "args": ["-y", "tm1-mcp-server"]
    }
  }
}
```

If you installed globally (`npm install -g tm1-mcp-server`), use the CLI name:

```json
{
  "mcpServers": {
    "tm1": {
      "command": "tm1-mcp-server"
    }
  }
}
```

For a source build (Option B), point at the built entrypoint:

```json
{
  "mcpServers": {
    "tm1": {
      "command": "node",
      "args": ["/absolute/path/to/tm1-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Code → server name `tm1` available.

## HTTP transport (Streamable, stateless)

Default transport is **stdio** (best for local Claude Code / Claude Desktop).
For multi-client / remote setups, switch to MCP **Streamable HTTP**:

```env
TM1_MCP_TRANSPORT=http
TM1_MCP_HTTP_HOST=127.0.0.1   # default — bind loopback only
TM1_MCP_HTTP_PORT=3000        # default
TM1_MCP_HTTP_ALLOWED_ORIGINS= # optional, comma-separated extra Origins past DNS-rebinding protection
TM1_MCP_HTTP_TOKEN=           # optional, require "Authorization: Bearer <token>" on every /mcp request
```

Then `npm start` exposes a single `POST /mcp` endpoint speaking JSON-RPC
(stateless mode, no session IDs). DNS-rebinding protection is on by default
and `Host`/`Origin` are validated against `allowedHosts: [host:port,
127.0.0.1, localhost]`.

```bash
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

> Setting `TM1_MCP_HTTP_HOST=0.0.0.0` exposes the server (and your TM1
> credentials) to the LAN — only do this behind a reverse proxy with
> additional auth.
>
> The HTTP transport has **no built-in authentication** unless you set
> `TM1_MCP_HTTP_TOKEN`. When set, every `/mcp` request must carry
> `Authorization: Bearer <token>` (others get `401`). Without it, bind to
> loopback only or front the server with an authenticating reverse proxy.

### Security

- Keep `TM1_PASSWORD` and any other secret only in `.env` (gitignored).
- `.mcp.json` and `~/.claude/settings.json` are often shared/committed —
  passing `env: { TM1_PASSWORD: "..." }` there leaks the credential into
  team configs, dotfile repos, and Claude Code session logs.
- If you must override per-host, use a per-host `.env` file rather than
  inline `env` blocks in client config.
- Need multiple TM1 environments? Run multiple server instances, each with
  its own working directory and `.env`. Distinguish by `mcpServers` key
  (e.g. `tm1-prod`, `tm1-dev`).

### autoApprove

`mcp.json.example` ships an `autoApprove` list of **read-only** tools only —
analyze/list/get/search/check/compile/diff. Destructive tools
(`delete_*`, `clear_*`, `unload_*`, `cancel_*`, `execute_*`,
`remove_*`, `invalidate_*`) and writes (`create_*`, `update_*`,
`upsert_*`, `write_cells`, `import_pro_file`, …) deliberately stay
**off** the allowlist and require manual approval per call.

Each tool also publishes MCP `readOnlyHint` / `destructiveHint` /
`idempotentHint` annotations (see `src/tools/annotation-map.ts`) so
clients that surface those hints can warn before invoking destructive
tools.

## Development

```bash
npm run dev      # tsx live-reload
npm test         # vitest
npm run lint     # tsc --noEmit
```

## Documentation

- [docs/EXAMPLES.md](docs/EXAMPLES.md) — working JSON tool-call payloads for every major feature
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layering, service-class pattern, transports, the readonly/readwrite gate
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, lint gates, how to add a tool or service
- [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — run
`npm run verify` (typecheck + lint gates + tests) before opening a PR. This is a
best-effort project with no support guarantee (see [Provenance](#provenance)).

## Analysis Tools

Bulk-load + callgraph tools for code review and dependency tracking:

- `tm1_get_all_processes_code` — all TI processes + 4 tabs in one roundtrip
- `tm1_get_all_cube_rules` — all cube rules in one roundtrip
- `tm1_search_code` — regex over all TI tabs with per-process / total caps; returns hit lines instead of full bulk
- `tm1_analyze_callgraph` — ExecuteProcess/RunProcess tree (downstream/upstream) with parameter env propagation. `mode='summary'` returns flat per-process aggregates (occurrences, depthMin/Max) for triage before pulling a heavy tree. Omit `start` for a global ranking: every process ranked by `rankBy='outgoing'` (fan-out) or `'incoming'` (fan-in) call counts — answers "which process triggers / is triggered by the most others" without a per-process traversal.
- `tm1_analyze_object_usage` — find cube/dim references across TI + rules
- `tm1_trace_data_flow` — up/downstream data flow for a cube in one call (processes that read it + where they write, writers + their sources). Pass `element` + `dimension` to answer "which processes touch element X of dimension D": each touching process is classified `access = source | write | zero-out | indeterminate` (so a zero-out isn't mistaken for a read), resolved from in-code subset builds, stored view/subset datasources (native-title/static exact, MDX by literal member), and — with `resolveComputed=true` — live-evaluated computed axis selectors (`TM1FILTERBYLEVEL`/`DESCENDANTS`/…).
- `tm1_analyze_chore_graph` — per-task downstream tree for a chore
- `tm1_invalidate_callgraph_cache` — reset 60s TTL cache after deploy
- `tm1_audit_naming` — bulk-scan all TM1 objects against IBM Planning Analytics naming conventions (PA 2.0 + 3.1)
- `tm1_audit_complexity` — bulk-scan TI processes + cube rules for complexity metrics (LOC, branches, max nesting, comment ratio) and cross-process consistency (variable-name clusters, type conflicts, prefix-convention adherence). Tolerates Bedrock-style condensed multi-statement lines.
- `tm1_audit_feeders` — bulk-scan cube rules for overfeeding patterns. Static heuristics S1–S5 (feeder broader than rule, feeder-into-consolidated, wildcard/unscoped brackets, DB() into cubes without `skipcheck;`, orphan feeders) plus `mode: "runtime" | "both"` for `}StatsByCube` evidence (cube_high_fed_ratio — fed/populated ≥ 50× hint, ≥ 100× evidence per TM1-community calibration — and cube_high_memory). Runtime evidence escalates static findings on the same cube from severity `hint` → `evidence`. CI gate via `severityThreshold: "evidence"`.

## MCP Resources

Four read-only resources for IDE sidebar browsing and `#`-references in chat:

| URI | Content | Completion |
|---|---|---|
| `tm1://server/info` | Server identity + config snapshot | — |
| `tm1://server/state` | Health-check: counts, connection state | — |
| `tm1://process/{name}/code` | TI process source (all 4 tabs, JSON) | name autocomplete |
| `tm1://cube/{name}/rules` | Cube rules text (plain text) | name autocomplete |

Completion callbacks filter by substring match (max 100 suggestions, control objects excluded).
Use `#tm1://process/MyProcess/code` in Claude Code chat to attach a process as context.

## TI Lifecycle (.pro file)

Tools that work on the native TM1 `.pro` serialization format — useful for
Bedrock-style libraries, version control, and brownfield deployments. The
parser handles tabs (572-575), parameters (560/561/590/637), variables
(577-582), and datasource (562-589).

- `tm1_import_pro_file` — parse a `.pro` and deploy in one call (create/update/upsert). Optional preflight via unbound compile.
- `tm1_diff_process_with_file` — compare installed process vs `.pro` (per-tab line counts + identical flag, parameter add/remove/change, variable diff, datasource diff). Use before import to preview.
- `tm1_install_pro_bundle` — iterate a directory of `.pro` files (optionally recursive, regex filename filter). Per-file mode + dryRun + continueOnError. Returns per-file outcome.
- `tm1_upsert_process` — same atomic-style bundle as `import_pro_file` but body is passed inline (no `.pro` parser).

## Pre-Write Validation

Catch the gap between "compile passes" and "runtime crashes":

- `tm1_check_process_code` — unbound process compile (no save). Returns syntax errors with procedure tab + line number.
- `tm1_check_cube_rule` — same for cube rules.
- `tm1_validate_process_refs` — scan TI code for cube/dim references in well-known functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementInsertDirect, AttrPutS/N, ElementSecurityPut, …) and verify each name resolves on the live model.
- `tm1_check_writable_coords` — pre-flight before CellPutN/S: every coord element exists, every element is N-Level (writes to Consolidated silent-fail), and a rule-overlap warning if the cube has rules.

## Compatibility

- Node.js >= 20
- TM1 11.8 (most tools); some metadata-write paths assume 11.x semantics
- v12-only features (e.g. `DataSource.usesUnicode`) gated behind `TM1_VERSION`

## Tool Reference

Auto-generated by `scripts/gen-tool-list.mjs` — run `npm run tools:update-readme` after registering or removing a tool.

<!-- TOOLS-AUTOGEN:START -->
## Tools (114)

### analysis (10)

- `tm1_analyze_callgraph` — Build a process call graph (ExecuteProcess/RunProcess) for a TI process
- `tm1_analyze_chore_graph` — Build downstream call graphs for every task of a TM1 chore
- `tm1_analyze_object_usage` — Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el])
- `tm1_audit_complexity` — Bulk-scan TI processes and cube rules for complexity metrics (LOC, branches, max nesting, score) 
- `tm1_audit_feeders` — Static heuristics (S1–S5) scan cube rules for overfeeding: wildcard brackets, feeders into consolidated 
- `tm1_audit_naming` — Bulk-scan TM1 objects against IBM PA 2.0/3.1 naming conventions; reports hard violations only 
- `tm1_check_v12_readiness` — Static gap-analysis against the TM1 / Planning Analytics v12 (Cloud Native) deprecation list
- `tm1_find_orphan_dimensions` — Identify dimensions not referenced by any cube — a model-hygiene check
- `tm1_invalidate_callgraph_cache` — Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph
- `tm1_trace_data_flow` — Trace data flow into and out of a cube in one call, instead of analyze_object_usage + N× get_process_code

### celldata (10)

- `tm1_check_feeders` — Check the feeders of a cell: verifies feeder coverage for the cells underlying this cell and returns the problematic ones with a fed flag — fed=false marks a br
- `tm1_check_writable_coords` — Pre-flight check before CellPutN/CellPutS
- `tm1_execute_mdx` — Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*)
- `tm1_get_cell_value` — Get a single cell value from a TM1 cube by specifying element coordinates
- `tm1_get_view` — Execute a named cube view and return structured cell data with axes (page-envelope shape consistent with tm1_execute_mdx)
- `tm1_get_view_definition` — Return the structural definition of a cube view (MDX expression OR NativeView axes) WITHOUT executing it
- `tm1_sample_cells` — Return up to maxCells populated cells from a cube without guessing coordinates — builds a NON EMPTY CROSSJOIN MDX over the cube's dimensions and HEAD-limits it
- `tm1_trace_cell_calculation` — Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rul
- `tm1_trace_feeders` — Trace the feeders of a cell: returns the cells this cell feeds plus the feeder statements involved — answers 'which feeder statement fires from this cell, and w
- `tm1_write_cells` — Write one or more cell values directly to a TM1 cube via REST

### dimension-management (13)

- `tm1_bulk_upsert_elements` — Create or update multiple elements in a TM1 hierarchy in bulk (two-pass: leafs first, then consolidations)
- `tm1_create_dimension` — Create a new TM1 dimension with a default hierarchy of the same name
- `tm1_create_element` — Create a new element in a TM1 dimension hierarchy
- `tm1_create_element_attribute` — Create an element attribute definition (schema) on a TM1 hierarchy
- `tm1_create_hierarchy` — Create a new (alternate) hierarchy inside an existing dimension
- `tm1_delete_dimension` — Delete a TM1 dimension and all its hierarchies
- `tm1_delete_element` — Delete an element from a TM1 dimension hierarchy
- `tm1_delete_hierarchy` — Delete a hierarchy from a dimension
- `tm1_get_element_attribute_values` — Read all attribute values (Numeric/String/Alias) for a single element via MDX on the }ElementAttributes_{Dim} control cube
- `tm1_list_element_attributes` — List element attribute definitions of a TM1 hierarchy with their types (Numeric/String/Alias)
- `tm1_move_element` — Move an element to a new parent within a TM1 dimension hierarchy
- `tm1_update_element` — Update an existing element in a TM1 dimension hierarchy (name, type, or components)
- `tm1_update_element_attribute_value` — Set a single attribute value on an element by writing to the }ElementAttributes_{Dim} control cube

### fileops (5)

- `tm1_delete_file` — Delete a file from the TM1 server's blob/file storage
- `tm1_get_file_content` — Read the content of a file from the TM1 server's data directory
- `tm1_list_files` — List files in the TM1 server's data directory (blob/file storage)
- `tm1_search_files` — Search file names in the TM1 server's blob/file storage by prefix and/or substring
- `tm1_upload_file` — Upload (create or update) a file in the TM1 server's blob/file storage

### metadata (9)

- `tm1_get_ancestors` — Get all ancestors of an element via parent-walk
- `tm1_get_descendants` — Get descendants of a consolidation element
- `tm1_get_hierarchy` — Get hierarchy elements with parent-child relationships for a dimension
- `tm1_list_chores` — List chores in the TM1 server with schedule and assigned processes
- `tm1_list_cubes` — List cubes in the TM1 server
- `tm1_list_dimensions` — List dimensions (with their hierarchy names) in the TM1 server
- `tm1_list_processes` — List TurboIntegrator processes (with parameters) in the TM1 server
- `tm1_list_processes_grouped` — Group TI processes by name prefix to give a structural overview without listing every process
- `tm1_resolve_default_members` — Resolve N hierarchies' effective default members in parallel from one tool call; pass items:[{dimensionName}] with a single entry for a one-off lookup

### model-building (9)

- `tm1_check_cube_rule` — Validate the syntax of a TM1 cube rule WITHOUT applying it
- `tm1_clear_cube` — Clear a subset of cells from a cube
- `tm1_create_cube` — Create a new TM1 cube with the specified dimensions
- `tm1_delete_cube` — Delete a TM1 cube and all its data
- `tm1_get_all_cube_rules` — Bulk-load rules text for every cube in one call
- `tm1_get_cube_rules` — Get the current rules text for a TM1 cube
- `tm1_search_rules` — Regex search across cube rules text
- `tm1_set_cube_rules` — Create or replace the rules for a TM1 cube
- `tm1_unload_cube` — Unload a cube from memory

### operations (15)

- `tm1_cancel_job` — Cancel a running TM1 v12 job by its ID
- `tm1_cancel_thread` — Cancel a running TM1 server thread by its ID
- `tm1_diagnose_process_error` — One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content, and optionally includes cascade-related sibling logs (same t
- `tm1_get_audit_log` — Fetch recent TM1 audit log entries (metadata/security changes: who changed what, when), newest first
- `tm1_get_cube_stats` — Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency)
- `tm1_get_error_log_content` — Fetch the raw text of one TI error log file produced by a failed process run
- `tm1_get_message_log` — Fetch recent TM1 server message log entries, newest first
- `tm1_get_server_info` — Return TM1 server identity + curated configuration (TI, Rules, MTQ, JobQueuing, Memory, Logging, HTTP, Security) from /Configuration + /ActiveConfiguration
- `tm1_get_server_state` — Health-check style snapshot of the TM1 server in one call
- `tm1_get_transaction_log` — Fetch recent TM1 transaction log entries (cell writes), newest first
- `tm1_list_error_logs` — List TI process error log files on the TM1 server, newest first
- `tm1_list_jobs` — List active jobs (Activity) on a TM1 v12 database — the running tasks that replaced v11 threads
- `tm1_list_sessions` — List active sessions on the TM1 server with their associated user and threads
- `tm1_list_threads` — List active threads on the TM1 server (running processes, chores, MDX queries, etc.)
- `tm1_save_data` — Persist in-memory cube data to disk: SaveDataAll (all cubes) or CubeSaveData when `cube` is given

### scheduling (5)

- `tm1_create_chore` — Create a new TM1 chore with a schedule and list of TI processes to run
- `tm1_delete_chore` — Delete a TM1 chore permanently
- `tm1_execute_chore` — Execute a TM1 chore immediately, bypassing its schedule
- `tm1_toggle_chore` — Activate or deactivate a TM1 chore (enable/disable its schedule).
- `tm1_update_chore` — Update an existing TM1 chore

### security (8)

- `tm1_assign_client_group` — Assign a TM1 client to a group
- `tm1_create_client` — Create a new TM1 client (user)
- `tm1_delete_client` — Delete a TM1 client (user)
- `tm1_get_client` — Get details for a single TM1 client (user) including group memberships.
- `tm1_list_clients` — List TM1 clients (users)
- `tm1_list_groups` — List TM1 groups
- `tm1_remove_client_group` — Remove a TM1 client from a group
- `tm1_update_client` — Update a TM1 client

### subsets (5)

- `tm1_create_subset` — Create a public TM1 subset
- `tm1_delete_subset` — Delete a public TM1 subset
- `tm1_get_subset` — Get a single TM1 subset with its MDX expression (if any) and resolved element list
- `tm1_list_subsets` — List public + private subsets of a TM1 hierarchy
- `tm1_update_subset` — Update a public TM1 subset (partial)

### ti-development (21)

- `tm1_check_process_code` — Validate TI process code WITHOUT saving it on the server (POST /api/v1/CompileProcess unbound)
- `tm1_compile_process` — Compile a TI process to validate its syntax without executing it
- `tm1_copy_process` — Copy a TI process (including variables and datasource) to a new name
- `tm1_delete_process` — Delete a TurboIntegrator process from the TM1 server
- `tm1_diff_process_with_file` — Compare an installed TI process on the server against a local .pro file
- `tm1_diff_processes` — Compare two installed TI processes tab-by-tab (Prolog/Metadata/Data/Epilog)
- `tm1_execute_process` — Execute a TurboIntegrator process on the TM1 server with optional parameters
- `tm1_export_process_to_git` — Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, datasource) plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as p
- `tm1_export_process_to_pro` — Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body
- `tm1_get_all_processes_code` — Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) fo
- `tm1_get_process` — Native full read of a TI process — the read-twin of tm1_upsert_process
- `tm1_get_process_code` — Get the source code of all four tabs (Prolog, Metadata, Data, Epilog) of a TI process
- `tm1_get_process_datasource` — Get the data source configuration of a TurboIntegrator process
- `tm1_get_process_parameters` — Get the parameters of a TurboIntegrator process including names, types and defaults
- `tm1_get_process_variables` — Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process
- `tm1_import_pro_file` — Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call
- `tm1_import_process_from_git` — Deploy a TM1 process from the tm1-git two-file layout ('{name}.json' + '{name}.ti')
- `tm1_install_pro_bundle` — Install all .pro files from a directory in one call
- `tm1_search_code` — Regex search across all TI process code (Prolog/Metadata/Data/Epilog)
- `tm1_upsert_process` — Atomic-style create-or-update for a TI process
- `tm1_validate_process_refs` — Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementIn

### views (4)

- `tm1_create_mdx_view` — Create a public MDX-based view on a cube
- `tm1_create_native_view` — Create a public native (subset-based) view on a cube — the classic view type used as TI process datasource 
- `tm1_delete_view` — Delete a public view from a cube
- `tm1_list_views` — List public and private views defined on a cube

<!-- TOOLS-AUTOGEN:END -->

## Troubleshooting

**TLS / self-signed certificate errors** (`unable to verify the first
certificate`, `self-signed certificate`): TM1 dev servers often use self-signed
certs. Set `TM1_SSL_REJECT_UNAUTHORIZED=false` for those — but only for dev,
never against production.

**`401` / authentication failed:** verify `TM1_USER` / `TM1_PASSWORD` and that
`TM1_BASE_URL` points at the REST API port (e.g. `https://host:8010`). Some test
servers allow a blank admin password — an empty `TM1_PASSWORD` is accepted and
the server logs a warning rather than blocking, so the real TM1 `401` surfaces
with context. For CAM/LDAP servers a `401` usually means the wrong
`TM1_NAMESPACE` (or an interactive account on PA Cloud — use a non-interactive
service account); confirm the server's `IntegratedSecurityMode` via
`tm1_get_server_info`.

**v11 vs v12 feature errors** (`DataSource.usesUnicode`, hierarchy/`Files`
endpoints): set `TM1_VERSION=11.8` (or your `11.x`) so v12-only paths are
disabled. The file service auto-falls back from the v12 `Files` root to the v11
`Blobs` root.

**HTTP transport: `401 Unauthorized` on `/mcp`:** `TM1_MCP_HTTP_TOKEN` is set —
send `Authorization: Bearer <token>`. **Connection refused / origin rejected:**
the server binds `127.0.0.1` by default and validates `Host`/`Origin`; add your
origin to `TM1_MCP_HTTP_ALLOWED_ORIGINS`, or set `TM1_MCP_HTTP_HOST` (loopback
only unless fronted by an authenticating proxy).

**`tm1_get_transaction_log` is slow or times out:** the TM1 transaction log is a
full scan. Always pass a tight `since` window; broad queries can hit the query
timeout.

**Startup error `Invalid TM1_…: expected a positive integer`:** a numeric env
var (`TM1_KEEP_ALIVE_INTERVAL`, `TM1_REQUEST_TIMEOUT`, `TM1_MCP_HTTP_PORT`) has a
non-numeric or non-positive value. Fix the value or unset it to use the default.

## Provenance

This codebase was generated by an AI coding agent (Anthropic's Claude),
reviewed and tested but not written by hand. The test suite is also
AI-generated and runs against mocks, not a live TM1 server — passing tests do
not guarantee correct REST semantics on your Planning Analytics version. Verify
behavior against your own instance before relying on it, especially for any
write or destructive operation. Provided "as is", best-effort, no support
guarantee. See [NOTICE](NOTICE).

IBM, Planning Analytics, and TM1 are trademarks of IBM Corp. This project is
not affiliated with or endorsed by IBM.

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with, sponsored by, or endorsed by IBM.
IBM, TM1, and Planning Analytics are trademarks of International Business
Machines Corporation. The names are used here solely to describe
compatibility with the TM1 REST API.
