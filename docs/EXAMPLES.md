# tm1-mcp-server Examples

Working examples for every major feature. Snippets are JSON tool-call payloads — paste into any MCP-aware client (Claude Code, Claude Desktop, etc.). Defaults assume server name `tm1`.

> Tip: every list_*/get_* tool now accepts `format: "json"|"markdown"`. Default is `json` (parsed into `structuredContent` by the Proxy); use `"markdown"` when you want a readable table dropped straight into chat.

---

## 1. Metadata listing

### 1.1 List user-defined cubes only, dimension-projection off

```json
{
  "tool": "tm1_list_cubes",
  "args": { "includeControl": false, "includeDimensions": false, "limit": 100 }
}
```

### 1.2 Find all cubes whose name matches a pattern

```json
{
  "tool": "tm1_list_cubes",
  "args": { "nameRegex": "^Sales_", "includeRules": true }
}
```

### 1.3 Headcount: dimensions with their hierarchy element counts

```json
{
  "tool": "tm1_list_dimensions",
  "args": { "includeElementCount": true, "includeControl": false, "format": "markdown" }
}
```

### 1.4 Show TI processes grouped by name prefix (audit shape)

```json
{
  "tool": "tm1_list_processes_grouped",
  "args": { "prefixSegments": 1, "minCount": 3, "excludePattern": "^Bedrock\\." }
}
```

---

## 2. Cell data — read

### 2.1 Execute MDX with paginated cells

```json
{
  "tool": "tm1_execute_mdx",
  "args": {
    "mdx": "SELECT NON EMPTY {[Versions].[Actual]} ON 0, NON EMPTY {[Year].[2024]} ON 1 FROM [Sales]",
    "limit": 50
  }
}
```

### 2.2 Read a single cell value

```json
{
  "tool": "tm1_get_cell_value",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "elements": ["2024", "DE", "P001", "Actual", "Amount"]
  }
}
```

### 2.3 Sample N random populated cells (audit / smoke-test)

```json
{
  "tool": "tm1_sample_cells",
  "args": { "cubeName": "Sales", "sampleSize": 20, "skipZeros": true }
}
```

---

## 3. Cell data — write (use sparingly; prefer TI)

### 3.1 Pre-flight check writable coords (rule overlap, N-level)

```json
{
  "tool": "tm1_check_writable_coords",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "cells": [
      { "elements": ["2024", "DE", "P001", "Budget", "Amount"], "value": 100 }
    ]
  }
}
```

### 3.2 Write one cell

```json
{
  "tool": "tm1_write_cells",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "cells": [
      { "elements": ["2024", "DE", "P001", "Budget", "Amount"], "value": 100 }
    ]
  }
}
```

### 3.3 Bulk write batch of cells

```json
{
  "tool": "tm1_write_cells",
  "args": {
    "cubeName": "Sales",
    "dimensions": ["Year", "Region", "Product", "Versions", "Measures"],
    "cells": [
      { "elements": ["2024", "DE", "P001", "Budget", "Amount"], "value": 100 },
      { "elements": ["2024", "DE", "P002", "Budget", "Amount"], "value": 250 },
      { "elements": ["2024", "FR", "P001", "Budget", "Amount"], "value": 80 }
    ]
  }
}
```

---

## 4. TI Development

### 4.1 Validate code without saving (pre-flight)

```json
{
  "tool": "tm1_check_process_code",
  "args": {
    "name": "Load_Sales",
    "prolog": "DatasourceNameForServer = '|filename|';",
    "data": "CellPutN(NValue, 'Sales', vYear, vRegion, vProduct, 'Actual', 'Amount');",
    "parameters": [{ "name": "filename", "type": "String", "defaultValue": "sales_2024.csv" }]
  }
}
```

### 4.2 Atomic create-with-bundle (parameters + variables + code)

```json
{
  "tool": "tm1_upsert_process",
  "args": {
    "name": "Load_Sales",
    "parameters": [{ "name": "filename", "type": "String", "defaultValue": "sales.csv" }],
    "variables": [],
    "dataSource": { "type": "ASCII", "dataSourceNameForServer": "sales.csv" },
    "prolog": "...",
    "metadata": "...",
    "data": "...",
    "epilog": "..."
  }
}
```

### 4.3 Diff installed process vs. local .pro file

```json
{
  "tool": "tm1_diff_process_with_file",
  "args": { "processName": "Load_Sales", "proFilePath": "/path/to/Load_Sales.pro" }
}
```

### 4.4 Search across all TI source code

```json
{
  "tool": "tm1_search_code",
  "args": { "pattern": "ExecuteProcess.*Bedrock", "regex": true, "maxResults": 100 }
}
```

---

## 5. TI Lifecycle (.pro files)

### 5.1 Import a .pro file (parse + deploy in one call)

```json
{
  "tool": "tm1_import_pro_file",
  "args": { "proFilePath": "/path/to/Load_Sales.pro", "overwrite": true }
}
```

### 5.2 Install a directory of .pro files

```json
{
  "tool": "tm1_install_pro_bundle",
  "args": { "directory": "/path/to/processes", "overwrite": false }
}
```

### 5.3 Export installed process to .pro

```json
{
  "tool": "tm1_export_process_to_pro",
  "args": { "processName": "Load_Sales", "outputPath": "/tmp/Load_Sales.pro" }
}
```

---

## 6. Subsets / Views

### 6.1 List subsets in markdown

```json
{
  "tool": "tm1_list_subsets",
  "args": { "dimensionName": "Region", "hierarchyName": "Region", "format": "markdown" }
}
```

### 6.2 Create an MDX-based public view

```json
{
  "tool": "tm1_create_mdx_view",
  "args": {
    "cubeName": "Sales",
    "viewName": "v_Sales_2024_DE",
    "mdx": "SELECT {[Year].[2024]} ON 0, {[Region].[DE].Children} ON 1 FROM [Sales]",
    "isPrivate": false
  }
}
```

### 6.2b Create a native (subset-based) view — TI datasource / suppressed export

```json
{
  "tool": "tm1_create_native_view",
  "args": {
    "cubeName": "Sales",
    "viewName": "v_Sales_Export",
    "rows": [{ "dimension": "Region", "subset": "EU_Countries" }],
    "columns": [{ "dimension": "Month", "expression": "{TM1SUBSETALL([Month])}" }],
    "titles": [
      { "dimension": "Version", "elements": ["Actual"], "selected": "Actual" },
      { "dimension": "Year", "expression": "{TM1SUBSETALL([Year])}", "selected": "2026" }
    ],
    "suppressEmptyRows": true
  }
}
```

Every cube dimension must appear in exactly one of rows/columns/titles. Per
axis entry exactly one subset source: registered `subset`, MDX `expression`,
or explicit `elements` (the latter two create anonymous subsets). Titles
require `selected` — TM1 rejects title subsets without a selected element.

### 6.3 Create a subset from an MDX expression

```json
{
  "tool": "tm1_create_subset",
  "args": {
    "dimensionName": "Region",
    "hierarchyName": "Region",
    "subsetName": "EU_Countries",
    "expression": "{TM1FILTERBYLEVEL({TM1SUBSETALL([Region])}, 0)}"
  }
}
```

---

## 7. Scheduling (chores)

### 7.1 Create a chore that runs daily at 06:00 UTC

```json
{
  "tool": "tm1_create_chore",
  "args": {
    "name": "DailyLoad",
    "startTime": "2026-05-10T06:00:00Z",
    "active": true,
    "executionMode": "MultipleCommit",
    "frequency": { "days": 1, "hours": 0, "minutes": 0, "seconds": 0 },
    "steps": [
      { "process": "Load_Sales", "parameters": [{ "name": "filename", "value": "sales.csv" }] },
      { "process": "Calc_KPIs", "parameters": [] }
    ]
  }
}
```

### 7.2 Activate or deactivate an existing chore

```json
{
  "tool": "tm1_toggle_chore",
  "args": { "name": "DailyLoad", "active": false }
}
```

### 7.3 Run a chore on demand

```json
{
  "tool": "tm1_execute_chore",
  "args": { "name": "DailyLoad" }
}
```

---

## 8. Security

### 8.1 List clients in markdown with group counts

```json
{
  "tool": "tm1_list_clients",
  "args": { "groupCount": true, "format": "markdown" }
}
```

### 8.2 Create a new client and assign a group

```json
[
  { "tool": "tm1_create_client", "args": { "name": "alice", "password": "..." } },
  { "tool": "tm1_assign_client_group", "args": { "client": "alice", "group": "ADMIN" } }
]
```

### 8.3 Look up a single client's groups

```json
{ "tool": "tm1_get_client", "args": { "name": "alice", "format": "markdown" } }
```

---

## 9. Operations / Diagnostics

### 9.1 Server health snapshot

```json
{ "tool": "tm1_get_server_state", "args": { "format": "markdown" } }
```

### 9.2 Diagnose a failed TI in one call (cascade-aware)

```json
{
  "tool": "tm1_diagnose_process_error",
  "args": {
    "processName": "Load_Sales",
    "since": "2026-05-09T00:00:00",
    "tail": 80,
    "includeRelated": true
  }
}
```

### 9.3 Recent transaction-log writes for one cube/user

```json
{
  "tool": "tm1_get_transaction_log",
  "args": {
    "top": 50,
    "cubeName": "Sales",
    "user": "alice",
    "since": "2026-05-09T00:00:00",
    "format": "markdown"
  }
}
```

### 9.4 Why is this cell X / empty? (calculation trace, v11)

```json
{
  "tool": "tm1_trace_cell_calculation",
  "args": {
    "cubeName": "Cube_PnL_Integration",
    "elements": ["2026_01", "Budget", "CC_SAP", "ACC_GrossSalary", "EUR", "AmountGroup"],
    "maxDepth": 3,
    "maxComponents": 10
  }
}
```

Returns the recursive component tree (rule/consolidation/simple, values, rule
statements) — follows DB() references across cubes. `truncated: true` marks cut
branches; re-run with that node's `tuple`/`cube` to drill deeper.

### 9.5 Does this cell feed correctly? (feeder trace, v11)

```json
{
  "tool": "tm1_trace_feeders",
  "args": {
    "cubeName": "Cube_PnL_Integration",
    "elements": ["2026_01", "Budget", "CC_SAP", "ACC_GrossSalary", "EUR", "AmountLocal"]
  }
}
```

Returns the cells this cell feeds plus the feeder statements that fire.
`tm1_check_feeders` (same args) verifies feeder coverage instead — an empty
result means no broken feeders detected.

### 9.6 Persist data to disk (v11)

```json
{ "tool": "tm1_save_data", "args": { "cube": "Sales" } }
```

Omit `cube` for SaveDataAll. Run after write sessions; truncates the
transaction log for saved cubes.

### 9.7 Who changed what? (audit log, v11)

```json
{
  "tool": "tm1_get_audit_log",
  "args": {
    "objectType": "Dimension",
    "since": "2026-06-01T00:00:00Z",
    "includeDetails": true,
    "format": "markdown"
  }
}
```

Metadata/security changes (logins, object edits, chore runs) — complements the
transaction log (cell writes). Requires `AuditLogOn=T` in tm1s.cfg; an empty
result on an active server usually means auditing is disabled (check
`auditLogEnabled` in `tm1_get_server_info`).

---

## 10. Code-graph analysis

### 10.1 Full callgraph for one process (recursive)

```json
{
  "tool": "tm1_analyze_callgraph",
  "args": { "processName": "Load_Sales", "summary": false }
}
```

### 10.2 Find every TI / chore / view that references a cube

```json
{
  "tool": "tm1_analyze_object_usage",
  "args": { "objectType": "cube", "objectName": "Sales" }
}
```

### 10.3 Validate process references resolve (cube/dim names)

```json
{
  "tool": "tm1_validate_process_refs",
  "args": { "processName": "Load_Sales" }
}
```

---

## Markdown vs. JSON output

Add `format: "markdown"` to any list_* tool or to these get_* tools for human-readable output:

`tm1_get_server_info`, `tm1_get_server_state`, `tm1_get_cube_stats`, `tm1_get_message_log`, `tm1_get_transaction_log`, `tm1_get_process_parameters`, `tm1_get_process_variables`, `tm1_get_process_datasource`, `tm1_get_ancestors`, `tm1_get_descendants`, `tm1_get_element_attribute_values`, `tm1_get_client`.

Default `json` is preferred for agent consumption — the Proxy parses it into `structuredContent` so typed clients can consume the payload directly.

## MCP Resources

Beyond tools, the server exposes URI-addressable read-only resources. IDE clients (Kiro, VSCode Copilot Chat) can `#`-reference them in chat or browse a sidebar tree.

### List all resources

```jsonrpc
{ "jsonrpc": "2.0", "id": 1, "method": "resources/list" }
```

Returns 2 static + N process-code templates (one per non-control TI) + M cube-rules templates (one per cube with rules).

### Static resources

| URI | Mime | Content |
|---|---|---|
| `tm1://server/info` | application/json | full TM1 server config (matches `tm1_get_server_info`) |
| `tm1://server/state` | application/json | health snapshot: connected, version, object counts |

### Resource templates (dynamic)

| Template | Mime | Content |
|---|---|---|
| `tm1://process/{name}/code` | application/json | Prolog/Metadata/Data/Epilog of TI process |
| `tm1://cube/{name}/rules` | text/plain | rules text (SKIPCHECK + FEEDERS) |

### Read example

```jsonrpc
{ "jsonrpc": "2.0", "id": 2, "method": "resources/read",
  "params": { "uri": "tm1://process/Load_Sales/code" } }
```

URLs use URI-encoding for special characters (`/`, spaces, etc.).

## MCP Prompts

Slash-command workflow templates surfaced by IDE clients. Each prompt briefs the LLM with a concrete tool sequence.

### List

```jsonrpc
{ "jsonrpc": "2.0", "id": 1, "method": "prompts/list" }
```

### Available prompts

| Name | Args | Use case |
|---|---|---|
| `tm1_diagnose_process` | `processName` | Root-cause failed TI: error logs → cascade → params → code → refs → callgraph |
| `tm1_audit_cube` | `cubeName` | Read-only health audit: shape → rules → stats → object-usage → tx log |
| `tm1_health_check` | — | Server snapshot: state, sessions, threads, error logs, message log |
| `tm1_rules_review` | `cubeName` | Code-review rules: SKIPCHECK, FEEDERS, N/C splits, syntax check, deps |

### Get a prompt

```jsonrpc
{ "jsonrpc": "2.0", "id": 2, "method": "prompts/get",
  "params": { "name": "tm1_diagnose_process",
              "arguments": { "processName": "Load_Sales" } } }
```

Returns one user message with the workflow text. The LLM follows it autonomously.

## Error hints

Failures return uniform JSON:

```json
{
  "code": "NOT_FOUND",
  "message": "Cube 'Saless' does not exist",
  "httpStatus": 404,
  "endpoint": "/api/v1/Cubes('Saless')",
  "hint": "Object does not exist. Use the matching list_* or get_* tool to enumerate available names before retrying."
}
```

A subset of high-signal tools (`tm1_set_cube_rules`, `tm1_create_process`, `tm1_execute_process`, `tm1_write_cells`, `tm1_execute_mdx`) attach a tool-context hint that names the right pre-flight or diagnose tool.
