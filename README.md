# tm1-mcp-server

Model Context Protocol (MCP) server for IBM Planning Analytics / TM1.
Exposes the full TM1 model lifecycle — metadata, dimensions, cubes, cell I/O,
TI processes, chores, security, code-graph analysis — to any MCP-compatible
LLM client (Claude Code, Claude Desktop, etc.).

Tested against TM1 11.8 (REST, Basic/CAM auth) and TM1 12.5 / Planning Analytics
Engine (rerooted REST, `s2s` auth live-validated).

> **Companion — TM1 IDE for VS Code.** Pair this server with the
> [**flameY3T1.vscode-tm1-ide**](https://marketplace.visualstudio.com/items?itemName=flameY3T1.vscode-tm1-ide)
> extension to browse and inspect the **live** data, cubes and TI code on the
> server — an in-place view of whatever MCP just changed.

## Features

114 tools across 12 categories — every one listed in
[docs/TOOLS.md](docs/TOOLS.md), with working JSON payloads in
[docs/EXAMPLES.md](docs/EXAMPLES.md). Past plain CRUD over the REST API:

- **Bulk reads instead of N round-trips.** Pull every process's source or every
  cube's rules in one call, then regex-search across them with per-process and
  total caps.
- **Code-graph analysis.** The ExecuteProcess/RunProcess call tree with
  parameter propagation, a summary mode for triage and a global fan-in/fan-out
  ranking; cube and dimension references across both TI and rules; a data-flow
  trace saying which processes read a cube and which write it, classifying each
  toucher of an element as source, write or zero-out.
- **Model audits.** Naming conventions (IBM PA 2.0/3.1), TI and rule complexity,
  feeder overfeeding (static heuristics plus `}StatsByCube` runtime evidence),
  v12 readiness, orphan dimensions.
- **Validation before you write.** Unbound compile of process code or a cube
  rule without saving; a check that every cube/dimension named in TI resolves
  live; a coordinate check that catches the silent no-op of writing to a
  consolidated element.
- **TI lifecycle in version control.** Import, export, diff and bundle-install
  native `.pro` files, or the diff-friendly two-file git layout
  (`{name}.json` + `{name}.ti`).
- **Resources and prompts, not just tools.** Four read-only resources with name
  autocomplete, so `#tm1://process/MyProcess/code` attaches a process as context
  in chat, plus five starting-point prompts.

> **Token tip:** every registered tool's name + input schema costs context on
> *each* turn, so exposing all 114 is wasteful when a session needs a slice.
> Narrow the surface with your client's tool filter; `TM1_MODE=readonly` already
> trims it to read-only tools.

## Install

**Option A — npm (recommended).** No clone, no build: `npx -y tm1-mcp-server`
always pulls the latest published version. Or install the CLI globally:

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

To update: `npx` picks up new versions on next start (if one is cached,
`npm cache clean --force`); a global install takes
`npm install -g tm1-mcp-server@latest`; a source install takes
`git pull && npm install && npm run build`. Always **restart the MCP client**
afterwards — the server process is only spawned at client startup.

## Configure

Copy `.env.example` to `.env` and set the TM1 connection details:

```env
TM1_BASE_URL=https://your-tm1-server:8010
TM1_USER=admin
TM1_PASSWORD=your-password
TM1_SSL_REJECT_UNAUTHORIZED=false
TM1_VERSION=11.8
TM1_MODE=readonly                   # readonly (default) | readwrite
# TM1_RESPONSE_MODE=legacy          # structured (default) | legacy (deprecated)
# TM1_LOCAL_FILE_ROOT=/srv/tm1-git  # optional; enables host-disk file params
```

`TM1_RESPONSE_MODE=legacy` restores the pre-2.2 wire format for a client that
only reads `content[0].text` — a transitional escape hatch that will be removed
in a future major. [`.env.example`](.env.example) lists every variable with
inline comments; [docs/CONFIGURATION.md](docs/CONFIGURATION.md) covers the ones
needing more than a comment line — CAM/LDAP login, the TM1 v12 (Planning
Analytics Engine) connection and its auth modes, host-disk file access.

> **Safe by default:** the server starts in `TM1_MODE=readonly` — only read
> tools are registered, so it cannot mutate or delete anything. Set
> `TM1_MODE=readwrite` explicitly to enable the full lifecycle (cell writes,
> cube/dimension/process deletion, TI execution), and never point a `readwrite`
> server at production without reviewing the write path first.

Host-disk file access is default-off in the same spirit: the `.pro` and git
tools accept inline content, and touch host paths only once
`TM1_LOCAL_FILE_ROOT` names an allowed directory (paths outside it, and `..`
traversal, are rejected).

### Positioning — this is a single-user tool

The server holds **one TM1 identity per process** and every call runs with it.
That is the design, not a limitation to work around, and it has consequences
worth stating plainly:

- **The HTTP transport is single-tenant.** A bearer token authenticates the
  _endpoint_, not a caller. Everyone who reaches it shares the same TM1
  credential, session, caches and audit identity. The "fresh MCP server per
  request" wording in the architecture notes describes request isolation inside
  the process — it is not a security boundary between users.
- **`TM1_MODE=readwrite` with an admin account is a developer configuration**,
  not a production recommendation. In production, point the server at an account
  whose TM1 rights already match what the agent should be able to do — the
  server enforces no per-caller authorization of its own.
- **The confirmation guards are misuse protection, not access control.**
  Seventeen tools require a `confirm` argument repeating the target name
  verbatim: every `delete_*` and `clear_*`, plus `tm1_execute_process`,
  `tm1_execute_chore`, `tm1_write_cells`, `tm1_set_cube_rules` and
  `tm1_upload_file`. Anything that can call such a tool can also supply its
  `confirm` value — the guard only stops an auto-approving client firing an
  irreversible action without naming the target.

If you need multi-user access with per-caller identity, run one process per
identity behind your own front end rather than sharing one.

### Secrets — `TM1_ALLOW_UNMASKED_SECRETS`

Credential masking is on by default everywhere it applies. Several tools take a
`maskSecrets` parameter, and a **model** can set it to `false` — an opt-out of a
security control chosen by the thing being guarded against. That request is
ignored unless the operator sets `TM1_ALLOW_UNMASKED_SECRETS=true`. The default
degrades to "mask anyway" rather than failing the call, so an audit still gets
its report, just redacted.

## Use with Claude Code

Copy `mcp.json.example` to `.mcp.json` (project-local) or merge it into
`~/.claude/settings.json`. **Do not put `TM1_PASSWORD` in either file** — those
are routinely shared or committed; keep it in a gitignored `.env`
([where the server looks for one](docs/CONFIGURATION.md#where-credentials-are-read-from)).

For the `npx` install:

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

A **global** install uses `"command": "tm1-mcp-server"` (no `args`); a **source
build** uses `"command": "node"` with
`"args": ["/absolute/path/to/tm1-mcp-server/dist/index.js"]`, which is what
`mcp.json.example` shows. Restart Claude Code and the server appears as `tm1`.

## HTTP transport

The default transport is **stdio**, and that is the normal way to run this. For
remote or multi-client setups, `TM1_MCP_TRANSPORT=http` switches to MCP
Streamable HTTP (stateless, single `POST /mcp` endpoint). It is single-tenant:
its optional bearer token authenticates the endpoint, not the caller. Setup,
security notes and the `autoApprove` allowlist:
[docs/HTTP-TRANSPORT.md](docs/HTTP-TRANSPORT.md).

## Compatibility

- Node.js >= 20
- TM1 11.8 / Planning Analytics 2.0 — the primary target; some metadata-write
  paths assume 11.x semantics, and v12-only fields (e.g.
  `DataSource.usesUnicode`) are dropped when `TM1_VERSION` says `11.x`
- TM1 12.5 / Planning Analytics Engine — via `TM1_INSTANCE` + `TM1_DATABASE`,
  live-validated with `s2s` auth only. `tm1_list_threads`, `tm1_cancel_thread`
  and `tm1_save_data` are v11-only; `tm1_list_jobs` and `tm1_cancel_job` v12-only;
  v12 ships no `}Stats*` control cubes, so `tm1_get_cube_stats` and
  `tm1_audit_feeders` in `mode` `runtime`/`both` report the statistics as
  unavailable instead of returning metrics (static feeder analysis is unaffected)

<!-- TOOLS-AUTOGEN:START -->

## Tools (114)

Names and one-line descriptions: [docs/TOOLS.md](docs/TOOLS.md).

| Category | Tools |
|---|---|
| analysis | 10 |
| celldata | 10 |
| dimension-management | 13 |
| fileops | 5 |
| metadata | 9 |
| model-building | 9 |
| operations | 15 |
| scheduling | 5 |
| security | 8 |
| subsets | 5 |
| ti-development | 21 |
| views | 4 |
| **Total** | **114** |

<!-- TOOLS-AUTOGEN:END -->

`tm1_execute_process` and `tm1_save_data` return an `outcome` — `succeeded`,
`completed_with_errors`, `rolled_back` or `indeterminate` — and only `succeeded`
reports `success: true`, since TM1 answers HTTP 200 whatever happened.
`completed_with_errors` means changes **were** committed: retrying double-posts.

## Troubleshooting

The first connection usually fails on a self-signed dev certificate (set
`TM1_SSL_REJECT_UNAUTHORIZED=false` — dev only) or a `401` from the wrong
credentials, port or CAM namespace. Those, plus v11/v12 feature errors, slow
transaction-log queries and startup validation errors, are in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md#troubleshooting); HTTP-transport
specifics in [docs/HTTP-TRANSPORT.md](docs/HTTP-TRANSPORT.md#troubleshooting).

## Development

```bash
npm run dev             # tsx live-reload
npm test                # vitest
npm run lint            # tsc --noEmit && eslint .
npm run coverage:check  # vitest --coverage + coverage ratchet gate
npm run verify          # everything CI runs (typecheck + lint gates + coverage:check)
```

Contributions are welcome; run `npm run verify` before opening a PR.
[CONTRIBUTING.md](CONTRIBUTING.md) documents the gates, the coverage ratchet and
how to add a tool or service.

## Documentation

- [docs/TOOLS.md](docs/TOOLS.md) — every tool, grouped, with one-line descriptions
- [docs/EXAMPLES.md](docs/EXAMPLES.md) — working JSON tool-call payloads for every major feature
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — CAM login, TM1 v12 connection, host-disk file access
- [docs/HTTP-TRANSPORT.md](docs/HTTP-TRANSPORT.md) — Streamable HTTP setup, security, `autoApprove`
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layering, service-class pattern, transports, the readonly/readwrite gate
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, lint gates, coverage policy, how to add a tool
- [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

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

MIT — see [LICENSE](LICENSE). The IBM trademarks named above are used solely to
describe compatibility with the TM1 REST API.
