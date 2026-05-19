# tm1-mcp-server

Model Context Protocol (MCP) server for IBM Planning Analytics / TM1.
Exposes the full TM1 model lifecycle — metadata, dimensions, cubes, cell I/O,
TI processes, chores, security, and code-graph analysis — to any MCP-compatible
LLM client (Claude Code, Claude Desktop, etc.).

Tested against TM1 11.8 via REST API (Basic Auth).

## Features

108 tools across 13 categories:

| Category | Tools |
|---|---|
| Metadata | list cubes / dimensions / processes / chores, get hierarchy |
| Model Building | create/delete/clear/unload cube, get/update/check cube rules, bulk get all rules |
| Dimension Management | dim + hierarchy CRUD, element CRUD, bulk upsert, attribute CRUD |
| Subsets | list/get/create/update/delete subsets |
| Views | list / create MDX view / delete view |
| Cell Data | execute MDX, get view, get cell value, write cells, **pre-write coord check** (N-Level + rule-overlap warn) |
| TI Development | process CRUD, compile, **unbound check** (pre-save validation), get/update code (single + bulk), datasource, variables, parameters, **regex search across all TI**, **upsert (atomic-style bundle)**, **ref validation** (cube/dim resolve) |
| TI Lifecycle (.pro) | **import .pro file** (parse + 1-call deploy), **diff installed vs .pro**, **install bundle** (directory of .pro files) |
| Process Execution | execute process, get parameters |
| Scheduling | chore CRUD, execute, toggle |
| Security | client + group CRUD, group assignment |
| Operations | server info, message log, transaction log, threads, sessions, file ops |
| Analysis | callgraph (full + summary mode), object usage, chore graph, cache invalidation |

## Install

```bash
git clone https://github.com/flameY3T1/tm1-mcp-server.git
cd tm1-mcp-server
npm install
npm run build
```

## Configure

Copy `.env.example` to `.env` and set TM1 connection details:

```env
TM1_BASE_URL=https://your-tm1-server:8010
TM1_USER=admin
TM1_PASSWORD=your-password
TM1_SSL_REJECT_UNAUTHORIZED=false
TM1_VERSION=11.8
```

## Use with Claude Code

Credentials live in `.env` (loaded via `dotenv` at startup). The MCP client
config only points at the binary — **do not put `TM1_PASSWORD` in `.mcp.json`
or `settings.json`**.

Copy `mcp.json.example` to `.mcp.json` (project-local) or merge into
`~/.claude/settings.json`:

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

## Analysis Tools

Bulk-load + callgraph tools for code review and dependency tracking:

- `tm1_get_all_processes_code` — all TI processes + 4 tabs in one roundtrip
- `tm1_get_all_cube_rules` — all cube rules in one roundtrip
- `tm1_search_code` — regex over all TI tabs with per-process / total caps; returns hit lines instead of full bulk
- `tm1_analyze_callgraph` — ExecuteProcess/RunProcess tree (downstream/upstream) with parameter env propagation. `mode='summary'` returns flat per-process aggregates (occurrences, depthMin/Max) for triage before pulling a heavy tree.
- `tm1_analyze_object_usage` — find cube/dim references across TI + rules
- `tm1_analyze_chore_graph` — per-task downstream tree for a chore
- `tm1_invalidate_callgraph_cache` — reset 60s TTL cache after deploy
- `tm1_audit_naming` — bulk-scan all TM1 objects against IBM Planning Analytics naming conventions (PA 2.0 + 3.1)
- `tm1_audit_complexity` — bulk-scan TI processes + cube rules for complexity metrics (LOC, branches, max nesting, comment ratio) and cross-process consistency (variable-name clusters, type conflicts, prefix-convention adherence). Tolerates Bedrock-style condensed multi-statement lines.
- `tm1_audit_feeders` — bulk-scan cube rules for overfeeding patterns. Static heuristics S1–S6 (broader-than-cube ratio, feeder-into-consolidated, missing IF-guard over STET/IF-conditional rules, wildcard brackets, DB() into cubes without `skipcheck;`, orphan feeders) plus `mode: "runtime" | "both"` for `}StatsByCube` evidence (cube_low_sparsity, cube_high_memory). Runtime evidence escalates static findings on the same cube from severity `hint` → `evidence`. CI gate via `severityThreshold: "evidence"`. See `docs/feeders-audit-spec.md`.

The callgraph engine is vendored from a sibling project (`vscode-tm1-ti`) under
`src/lib/callgraph/`. Same author, same MIT license.

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

- Node.js >= 18
- TM1 11.8 (most tools); some metadata-write paths assume 11.x semantics
- v12-only features (e.g. `DataSource.usesUnicode`) gated behind `TM1_VERSION`

## Tool Reference

Auto-generated by `scripts/gen-tool-list.mjs` — run `npm run tools:update-readme` after registering or removing a tool.

<!-- TOOLS-AUTOGEN:START -->
## Tools (108)

### analysis (9)

- `tm1_analyze_callgraph` — Build a process call graph (ExecuteProcess/RunProcess) for a TI process
- `tm1_analyze_chore_graph` — Build downstream call graphs for every task of a TM1 chore
- `tm1_analyze_object_usage` — Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el])
- `tm1_audit_complexity` — Bulk-scan TI processes and cube rules for complexity + cross-process consistency
- `tm1_audit_feeders` — Bulk-scan cube rules for likely overfeeding patterns (P4)
- `tm1_audit_naming` — Bulk-scan all TM1 objects against IBM Planning Analytics naming conventions (PA 2.0 + 3.1 naming-conventions doc)
- `tm1_check_v12_readiness` — Static gap-analysis against the TM1 / Planning Analytics v12 (Cloud Native) deprecation list
- `tm1_find_orphan_dimensions` — Identify dimensions that are not referenced by any cube — a model hygiene check
- `tm1_invalidate_callgraph_cache` — Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph

### celldata (7)

- `tm1_check_writable_coords` — Pre-flight check before CellPutN/CellPutS
- `tm1_execute_mdx` — Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*)
- `tm1_get_cell_value` — Get a single cell value from a TM1 cube by specifying element coordinates
- `tm1_get_view` — Execute a named cube view and return structured cell data with axes
- `tm1_get_view_definition` — Return the structural definition of a cube view (MDX expression OR NativeView axes) WITHOUT executing it
- `tm1_sample_cells` — Return up to maxCells populated cells from a cube without guessing element coordinates
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

### knowledge (1)

- `tm1_get_knowledge` — Fetch TM1 knowledge articles from the local knowledge base (configured via TM1_KNOWLEDGE_DIR env var)

### metadata (10)

- `tm1_get_ancestors` — Get all ancestors of an element via parent-walk
- `tm1_get_descendants` — Get descendants of a consolidation element
- `tm1_get_hierarchy` — Get hierarchy elements with parent-child relationships for a given dimension
- `tm1_list_chores` — List chores in the TM1 server with schedule and assigned processes
- `tm1_list_cubes` — List cubes in the TM1 server
- `tm1_list_dimensions` — List dimensions in the TM1 server with their hierarchy names
- `tm1_list_processes` — List TurboIntegrator processes in the TM1 server with their parameters
- `tm1_list_processes_grouped` — Group TI processes by name prefix to give a structural overview without listing every process
- `tm1_resolve_default_member` — Resolve a hierarchy's effective default member in one call — avoids the 3-8 round-trip iterative level-scan when constructing view slicers
- `tm1_resolve_default_members` — Bulk variant of tm1_resolve_default_member — resolves N hierarchies in parallel from a single tool call

### model-building (8)

- `tm1_check_cube_rule` — Validate the syntax of a TM1 cube rule WITHOUT applying it
- `tm1_clear_cube` — Clear a subset of cells from a cube
- `tm1_create_cube` — Create a new TM1 cube with the specified dimensions
- `tm1_delete_cube` — Delete a TM1 cube and all its data
- `tm1_get_all_cube_rules` — Bulk-load rules text for every cube in one call
- `tm1_get_cube_rules` — Get the current rules text for a TM1 cube
- `tm1_set_cube_rules` — Create or replace the rules for a TM1 cube
- `tm1_unload_cube` — Unload a cube from memory

### operations (12)

- `tm1_cancel_thread` — Cancel a running TM1 server thread by its ID
- `tm1_diagnose_process_error` — One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content, and optionally includes cascade-related sibling logs (same t
- `tm1_get_cube_stats` — Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency)
- `tm1_get_error_log_content` — Fetch the raw text of one TI error log file produced by a failed process run
- `tm1_get_message_log` — Fetch recent TM1 server message log entries, newest first
- `tm1_get_server_capabilities` — Return key TM1 server capabilities as a flat, typed object
- `tm1_get_server_info` — Return TM1 server configuration (version, name, data directory, timezone, admin host).
- `tm1_get_server_state` — Health-check style snapshot of the TM1 server in one call
- `tm1_get_transaction_log` — Fetch recent TM1 transaction log entries (cell writes), newest first
- `tm1_list_error_logs` — List TI process error log files on the TM1 server, newest first
- `tm1_list_sessions` — List active sessions on the TM1 server with their associated user and threads
- `tm1_list_threads` — List active threads on the TM1 server (running processes, chores, MDX queries, etc.)

### scheduling (5)

- `tm1_create_chore` — Create a new TM1 chore with a schedule and list of TI processes to run
- `tm1_delete_chore` — Delete a TM1 chore permanently.
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

### ti-development (22)

- `tm1_check_process_code` — Validate TI process code WITHOUT saving it on the server (POST /api/v1/CompileProcess unbound)
- `tm1_compile_process` — Compile a TI process to validate its syntax without executing it
- `tm1_copy_process` — Copy a TI process (including variables and datasource) to a new name
- `tm1_create_process` — Create a new empty TurboIntegrator process on the TM1 server
- `tm1_delete_process` — Delete a TurboIntegrator process from the TM1 server
- `tm1_diff_process_with_file` — Compare an installed TI process on the server against a local .pro file
- `tm1_execute_process` — Execute a TurboIntegrator process on the TM1 server with optional parameters
- `tm1_export_process_to_pro` — Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body
- `tm1_get_all_processes_code` — Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call
- `tm1_get_process_code` — Get the source code of all four tabs (Prolog, Metadata, Data, Epilog) of a TI process
- `tm1_get_process_datasource` — Get the data source configuration of a TurboIntegrator process
- `tm1_get_process_parameters` — Get the parameters of a TurboIntegrator process including names, types and defaults
- `tm1_get_process_variables` — Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process
- `tm1_import_pro_file` — Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call
- `tm1_install_pro_bundle` — Install all .pro files from a directory in one call
- `tm1_search_code` — Regex search across all TI process code (Prolog/Metadata/Data/Epilog)
- `tm1_update_process_code` — Update one or more code tabs of a TI process (partial update supported)
- `tm1_update_process_datasource` — Update the data source configuration of a TurboIntegrator process
- `tm1_update_process_parameters` — Update the parameters of a TurboIntegrator process with names, types and defaults
- `tm1_update_process_variables` — Set the variables of a TurboIntegrator process
- `tm1_upsert_process` — Atomic-style create-or-update for a TI process
- `tm1_validate_process_refs` — Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementIn

### views (3)

- `tm1_create_mdx_view` — Create a public MDX-based view on a cube
- `tm1_delete_view` — Delete a public view from a cube.
- `tm1_list_views` — List public and private views defined on a cube

<!-- TOOLS-AUTOGEN:END -->

## License

MIT — see [LICENSE](LICENSE).
