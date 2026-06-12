# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅        |
| < 2.0   | ❌        |

Only the latest `2.x` release line receives security fixes.

## Reporting a Vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub's
[**Report a vulnerability**](https://github.com/flameY3T1/tm1-mcp-server/security/advisories/new)
(Security → Advisories → *Report a vulnerability*). This opens a confidential
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
- **`readwrite` is the default mode** and exposes destructive tools
  (cube/dimension deletion, cell writes, process execution). Set
  `TM1_MODE=readonly` on production instances. Running `readwrite` against
  production by choice is not a vulnerability.
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
