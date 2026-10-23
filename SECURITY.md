# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 6.x     | ✅        |
| < 6.0   | ❌        |

Only the latest major release line receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/flameY3T1/tm1-mcp-server/security/advisories/new)
(Security → Advisories → _Report a vulnerability_). This opens a confidential
advisory visible only to you and the maintainer.

Please include:

- affected version / commit
- a description of the issue and its impact
- reproduction steps or a proof of concept
- any suggested remediation

You can expect an initial acknowledgement within **7 days**. There is no bug
bounty — this is a community project maintained on a best-effort basis.

## Scope & Threat Model

This server bridges an MCP client (an LLM) to a live IBM Planning Analytics / TM1
instance over the TM1 REST API. Keep the following in mind before reporting:

- **Credentials belong in `.env` only.** `TM1_PASSWORD` and other secrets must
  never be placed in `.mcp.json`, `settings.json`, or any committed config —
  those files are frequently shared and would leak the credential. This is
  documented behaviour, not a vulnerability.
- **`readonly` is the default mode.** Destructive tools (cube/dimension
  deletion, cell writes, process execution) are disabled unless you explicitly
  opt in with `TM1_MODE=readwrite`. Enabling `readwrite` against production by
  choice is not a vulnerability.
- **`TM1_MODE=sandbox` confines cell writes to sandboxes named with
  `TM1_SANDBOX_PREFIX`.** A write that reaches base data, or a sandbox without
  the prefix, while the server runs in sandbox mode is in scope. The prefix is a
  naming convention: a person who names a sandbox with it by hand hands it to
  the server, and that is not a vulnerability.
- **HTTP transport binds loopback (`127.0.0.1`) by default.** Setting
  `TM1_MCP_HTTP_HOST=0.0.0.0` exposes the server and its TM1 credentials to the
  network; only do so behind a reverse proxy with its own auth. A self-inflicted
  LAN exposure via that flag is not a vulnerability.
- The LLM client ultimately decides which tools to invoke. Tool-level
  `readOnlyHint` / `destructiveHint` annotations are advisory; final
  authorization is the client's responsibility.

In scope: credential leakage paths, injection into TM1 REST calls, auth bypass
in the HTTP transport, secret-masking gaps, and anything that lets a tool act
outside its declared `readOnlyHint` / `destructiveHint` contract.

## Single-user design

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
  Twenty tools require a `confirm` argument repeating the target name
  verbatim: every `delete_*` and `clear_*`, plus `tm1_remove_client_group`,
  `tm1_execute_process`, `tm1_execute_chore`, `tm1_write_cells`,
  `tm1_set_cube_rules`, `tm1_upload_file`, `tm1_discard_sandbox` and
  `tm1_publish_sandbox`. Anything that can call such a
  tool can also supply its `confirm` value — the guard only stops an
  auto-approving client firing an irreversible action without naming the
  target.

If you need multi-user access with per-caller identity, run one process per
identity behind your own front end rather than sharing one.
