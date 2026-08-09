# HTTP transport (Streamable, stateless)

The default transport is **stdio**, which is how this server is meant to be run:
one local process, one TM1 identity, one user (see
[Positioning](../README.md#positioning--this-is-a-single-user-tool)). The HTTP
transport exists for remote or multi-client setups and does not change that — it
is single-tenant, and everything below follows from that.

## Configuration

```env
TM1_MCP_TRANSPORT=http
TM1_MCP_HTTP_HOST=127.0.0.1   # default — bind loopback only
TM1_MCP_HTTP_PORT=3000        # default
TM1_MCP_HTTP_ALLOWED_ORIGINS= # optional, comma-separated extra Origins past DNS-rebinding protection
TM1_MCP_HTTP_TOKEN=           # optional, require "Authorization: Bearer <token>" on every /mcp request
```

Then `npm start` exposes a single `POST /mcp` endpoint speaking JSON-RPC
(stateless mode, no session IDs). DNS-rebinding protection is on by default and
`Host`/`Origin` are validated against `allowedHosts: [host:port, 127.0.0.1,
localhost]`.

Smoke test:

```bash
curl -X POST http://127.0.0.1:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
```

## Security

> Setting `TM1_MCP_HTTP_HOST=0.0.0.0` exposes the server (and your TM1
> credentials) to the LAN — only do this behind a reverse proxy with
> additional auth.
>
> The HTTP transport has **no built-in authentication** unless you set
> `TM1_MCP_HTTP_TOKEN`. When set, every `/mcp` request must carry
> `Authorization: Bearer <token>` (others get `401`). Without it, bind to
> loopback only or front the server with an authenticating reverse proxy.

The bearer token authenticates the _endpoint_, not the caller. Everyone who
reaches it shares the same TM1 credential, session, caches and audit identity.
The "fresh MCP server per request" wording in the architecture notes describes
request isolation inside the process — it is not a security boundary between
users.

Credential hygiene, same as for stdio:

- Keep `TM1_PASSWORD` and any other secret only in `.env` (gitignored).
- `.mcp.json` and `~/.claude/settings.json` are often shared/committed —
  passing `env: { TM1_PASSWORD: "..." }` there leaks the credential into
  team configs, dotfile repos, and Claude Code session logs.
- If you must override per-host, use a per-host `.env` file rather than
  inline `env` blocks in client config.
- Need multiple TM1 environments? Run multiple server instances, each with
  its own working directory and `.env`. Distinguish by `mcpServers` key
  (e.g. `tm1-prod`, `tm1-dev`).

## autoApprove

`mcp.json.example` ships an `autoApprove` list of **read-only** tools only —
analyze/list/get/search/check/compile/diff, plus `tm1_execute_mdx` (a query, not
a mutation) and `tm1_export_process_to_pro`. Destructive tools (`delete_*`,
`clear_*`, `unload_*`, `cancel_*`, `execute_process`, `execute_chore`,
`remove_*`, `invalidate_*`) and writes (`create_*`, `update_*`, `upsert_*`,
`write_cells`, `import_pro_file`, …) deliberately stay **off** the allowlist and
require manual approval per call.

Each tool also publishes MCP `readOnlyHint` / `destructiveHint` /
`idempotentHint` annotations (see `src/tools/annotation-map.ts`) so clients that
surface those hints can warn before invoking destructive tools. Irreversible
full-replacement writes declare `destructiveHint: true` even though they delete
no object: `tm1_write_cells`, `tm1_set_cube_rules` and
`tm1_bulk_upsert_elements`.

## Troubleshooting

**`401 Unauthorized` on `/mcp`:** `TM1_MCP_HTTP_TOKEN` is set — send
`Authorization: Bearer <token>`.

**Connection refused / origin rejected:** the server binds `127.0.0.1` by
default and validates `Host`/`Origin`; add your origin to
`TM1_MCP_HTTP_ALLOWED_ORIGINS`, or set `TM1_MCP_HTTP_HOST` (loopback only unless
fronted by an authenticating proxy).
