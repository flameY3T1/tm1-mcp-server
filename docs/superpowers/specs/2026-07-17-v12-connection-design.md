# Design: TM1 / Planning Analytics v12 Connection

**Date:** 2026-07-17
**Status:** Approved design → implementation plan next
**Scope:** Connection/auth layer for TM1 v12 (Planning Analytics Engine). Connection only.
Jobs/Activity (`/Jobs`) is an explicit follow-up (see Out of Scope).

## Problem

The server today speaks only TM1 v11: `Authorization: Basic|CAMNamespace|CAMPassport`
→ login `GET /api/v1/Configuration/ProductVersion` → `TM1SessionId` cookie → every
request carries `Cookie: TM1SessionId=…` against `{baseUrl}/api/v1/…`.

v12 (Planning Analytics Engine) changes the connection contract. We need the ~120 existing
tools to work unchanged against a v12 database by adding a v12-aware connection layer.

## Verified facts (live-probed against a real v12 server, product version 12.5.9)

Server: `http://172.31.128.1:4444`, instance `tm1`, database `tm1_v12_test`, S2S mode.

**Login (S2S), confirmed:**
```
POST http://172.31.128.1:4444/tm1/auth/v1/session
  Authorization: Basic base64(client_id:client_secret)
  Content-Type: application/json
  {"User":"admin"}
→ 201 Created
  Set-Cookie: TM1SessionId=<JWT>; Path=/; HttpOnly
```
- JWT `exp - iat = 3600s` (1h).
- **Cookie is `TM1SessionId`** (not `paSession`) — the existing
  `extractSessionCookie` regex already handles it. No cookie-name delta.

**Data requests, confirmed with that cookie:**
```
GET {base}/Configuration/ProductVersion/$value      → 12.5.9
GET {base}/Cubes/$count                             → 7
GET {base}/ActiveUser?$select=Name                  → {"Name":"Admin"}
```
where `{base} = http://172.31.128.1:4444/tm1/api/v1/Databases('tm1_v12_test')`.

**Endpoint availability, confirmed (this server, backward-compatible):**
`/Threads` 200 · `/Sessions` 200 · `/ActiveSession` 200 · `/Jobs` 200 (`{"value":[]}`).
→ Existing monitoring tools do not break. `/ActiveSession` exists → keepalive/logout reroot works.

## Deltas from v11 (only three)

| Delta | v11 | v12 |
|---|---|---|
| URL re-root | `{base}/api/v1/X` | `{base}/{instance}/api/v1/Databases('{db}')/X` |
| Login request | `GET /api/v1/Configuration/ProductVersion`, header `Basic\|CAM…` | `POST /{instance}/auth/v1/session`, JSON body `{"User":user}`, mode-specific `Authorization` |
| Session endpoints (keepalive/logout) | `/api/v1/ActiveSession` | rerooted to v12 base |

Cookie name, cookie-based request flow, retry, 401 re-auth, dispatcher, and all 192
service call-sites are **unchanged**.

## Architecture

### Seam: `src/tm1-client/connection/`

A `ConnectionProfile` selected once at startup from config, injected into `SessionManager`
and `TM1HttpClient`. It owns exactly two responsibilities:

1. **`resolveApiPath(path: string): string`** — URL re-rooting.
   - v11: identity (`path` already begins `/api/v1/…`).
   - v12: `path.replace(/^\/api\/v1/, "/${instance}/api/v1/Databases('${odataEnc(db)}')")`.
   - Applied at the **6 URL-join points only**: 3 in `http.ts`
     (`request`, `requestRaw`, `requestBinary`) + 3 endpoint URLs in `session-manager.ts`
     (login, keepAlive, logout). The 192 service literals stay untouched.

2. **`LoginStrategy`** — builds the login round-trip and parses the session cookie.

Two profile implementations: `V11Profile`, `V12Profile`.

### LoginStrategy (the only thing that varies per auth mode)

Interface:
```ts
interface LoginStrategy {
  // Full URL + method + headers + body for the login round-trip.
  buildLoginRequest(): Promise<{ url: string; method: string; headers: Record<string,string>; body?: string }>;
}
```
The session-cookie parse (`TM1SessionId`) is shared across v11 and v12 (verified identical).

**v11 strategy** (unchanged behavior): `GET {baseUrl}/api/v1/Configuration/ProductVersion`,
`Authorization` = existing Basic/CAMNamespace/CAMPassport builder.

**v12 strategy** — shared mechanics: `POST {baseUrl}/{instance}/auth/v1/session`,
`Content-Type: application/json`, body `{"User": user}`, parse `TM1SessionId`.
Per-mode difference is only the `Authorization` header (+ optional pre-step):

| `TM1_AUTH_MODE` | Authorization on session POST | Pre-step | Validation |
|---|---|---|---|
| `s2s` | `Basic b64(client_id:client_secret)` | — | **live-validated** ✅ |
| `basic` (native, v11 instance) | `Basic b64(user:password)` | — | unit-only |
| `access_token` / `oidc` | `Bearer <access_token>` | — | unit-only |
| `iam` | `Bearer <token>` | exchange `api_key`@`iam_url` (`POST`, `grant_type=urn:ibm:params:oauth:grant-type:apikey`) → `access_token` | unit-only |

### Config (`config.ts`)

`TM1_BASE_URL` for v12 = address:port only, e.g. `http://172.31.128.1:4444` (no `/tm1`).

New env vars:
- `TM1_INSTANCE`, `TM1_DATABASE` — presence (or `TM1_VERSION` major = 12) selects v12.
- `TM1_AUTH_MODE` = `s2s | basic | access_token | oidc | iam`.
- s2s: `TM1_CLIENT_ID`, `TM1_CLIENT_SECRET`.
- access_token/oidc: `TM1_ACCESS_TOKEN`.
- iam: `TM1_API_KEY`, `TM1_IAM_URL`.
- `TM1_USER` reused for the `{"User": …}` body (all v12 modes).

`TM1Config` becomes a discriminated union on `version`:
- `{ version: 11, … }` — today's fields.
- `{ version: 12, instance, database, authMode, … + mode-specific creds }`.

Validation at load: v12 requires `instance` + `database`; each `authMode` requires its own
creds (fail fast at startup with a specific message, mirroring existing env parsing).

### SessionManager

Replace the hardcoded `buildAuthorizationHeader()` + ProductVersion URL with
`profile.loginStrategy.buildLoginRequest()`. keepAlive/logout call
`profile.resolveApiPath("/api/v1/ActiveSession")`. Everything else is untouched:
concurrent-login dedup, `staleCookie` churn-guard, keepAlive timer/unref, 401 re-auth.
JWT 1h expiry is covered by the existing keepalive (60s) + 401 re-auth paths.

### http.ts

Wrap the three `path` values through `profile.resolveApiPath(path)` at the URL joins.
No other change — retry, error classification, mutation events, dispatcher all stay.

### Secrets (`mask-secrets.ts`)

Add `client_secret`, `access_token`, `api_key` to the mask patterns. Logging emits
`authMode` only (extend the existing `authMode()` helper), never the credential.

## Testing

- **Unit:**
  - `resolveApiPath` — v11 identity; v12 rewrite incl. OData-encoded database name.
  - Each mode's `buildLoginRequest` — exact url/method/headers/body; IAM pre-step mock.
  - Cookie parse unchanged (regression).
  - Config load — v12 discriminated union, per-mode required-var errors.
- **Live (CI-excluded, alongside existing live suite):**
  - S2S vs `172.31.128.1:4444` — login round-trip + real tools (`get_server_info`,
    `list_cubes`) + keepalive + logout.
- **Honesty in CHANGELOG:** S2S = live-validated. `basic`/`access_token`/`oidc`/`iam`
  = unit-validated request-builders, **not yet live-validated** (no reachable target).
  Do not claim otherwise. (Repo precedent: CAM shipped unvalidated and is still flagged.)

## Out of scope (documented follow-ups)

- **v12 Jobs / Activity** — v12 threads are ephemeral (per-request); `/Jobs` is the
  "Activity" tab (in-progress requests). A `tm1_list_jobs` tool + v12-aware
  `list_threads`/`list_sessions` is a **separate follow-up spec**. Existing `/Threads`
  still 200s here, so nothing breaks meanwhile.
- **Cloud PAaaS tenant URL** (`https://{address}/api/{tenant}/v0/tm1/{database}`) —
  different base shape; defer until a target exists.
- **Impersonation** — blocked in v12 (`TM1-Impersonate` raises).
- **Refresh-token rotation** — existing 401 re-auth covers JWT expiry.

## Risks

- keepalive/logout under v12 base assumed from `/ActiveSession` 200 — confirm the
  full DELETE/GET round-trip during implementation live-test.
- `basic`/`oidc`/`iam` login-request shapes are from the TM1py reference + the verified
  S2S shape; live-validate when a target is available before claiming support.
