# tm1-mcp-server

Model Context Protocol (MCP) server for IBM Planning Analytics / TM1.
Exposes the full TM1 model lifecycle — metadata, dimensions, cubes, cell I/O,
TI processes, chores, security, and code-graph analysis — to any MCP-compatible
LLM client (Claude Code, Claude Desktop, etc.).

Tested against TM1 11.8 via REST API (Basic Auth).

## Features

84 tools across 13 categories:

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

## License

MIT — see [LICENSE](LICENSE).
