# tm1-mcp-server

Model Context Protocol (MCP) server for IBM Planning Analytics / TM1.
Exposes the full TM1 model lifecycle — metadata, dimensions, cubes, cell I/O,
TI processes, chores, security, and code-graph analysis — to any MCP-compatible
LLM client (Claude Code, Claude Desktop, etc.).

Tested against TM1 11.8 via REST API (Basic Auth).

## Features

72 tools across 12 categories:

| Category | Tools |
|---|---|
| Metadata | list cubes / dimensions / processes / chores, get hierarchy |
| Model Building | create/delete/clear/unload cube, get/update cube rules, bulk get all rules |
| Dimension Management | dim + hierarchy CRUD, element CRUD, bulk upsert, attribute CRUD |
| Subsets | list/get/create/update/delete subsets |
| Views | list / create MDX view / delete view |
| Cell Data | execute MDX, get view, get cell value, write cells |
| TI Development | process CRUD, compile, get/update code (single + bulk), datasource, variables, parameters |
| Process Execution | execute process, get parameters |
| Scheduling | chore CRUD, execute, toggle |
| Security | client + group CRUD, group assignment |
| Operations | server info, message log, transaction log, threads |
| Analysis | callgraph, object usage, chore graph, cache invalidation |

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

Add to `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "tm1": {
      "command": "node",
      "args": ["/absolute/path/to/tm1-mcp-server/dist/index.js"],
      "env": {
        "TM1_BASE_URL": "https://your-tm1-server:8010",
        "TM1_USER": "admin",
        "TM1_PASSWORD": "your-password",
        "TM1_VERSION": "11.8"
      }
    }
  }
}
```

Restart Claude Code → server name `tm1` available.

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
- `tm1_analyze_callgraph` — ExecuteProcess/RunProcess tree (downstream/upstream) with parameter env propagation
- `tm1_analyze_object_usage` — find cube/dim references across TI + rules
- `tm1_analyze_chore_graph` — per-task downstream tree for a chore
- `tm1_invalidate_callgraph_cache` — reset 60s TTL cache after deploy

The callgraph engine is vendored from a sibling project (`vscode-tm1-ti`) under
`src/lib/callgraph/`. Same author, same MIT license.

## Compatibility

- Node.js >= 18
- TM1 11.8 (most tools); some metadata-write paths assume 11.x semantics
- v12-only features (e.g. `DataSource.usesUnicode`) gated behind `TM1_VERSION`

## License

MIT — see [LICENSE](LICENSE).
