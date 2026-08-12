# Configuration reference

The short version lives in the [README](../README.md#configure); the full list
of variables with inline comments is [`.env.example`](../.env.example). This
page covers the settings that need more than a comment line.

## Where credentials are read from

Environment variables, resolved in this order (first hit wins per variable):

1. real shell / MCP-client `env:` vars
2. the `.env` file named by `DOTENV_CONFIG_PATH`
3. `.env` in the working directory the MCP client launches the server from
   (typically your project directory)
4. `.env` in the package root — the directory containing `dist/`. Works for
   clone+build installs; under `npx` this is the npm cache, so don't rely on it.

For the recommended `npx` install, put a `.env` in the project directory you
start your MCP client from, or point `DOTENV_CONFIG_PATH` at one via the MCP
config's `env` block. **Do not put `TM1_PASSWORD` in `.mcp.json` or
`settings.json`** — those files are routinely shared or committed. Keep secrets
in a `.env` that stays out of version control.

## Wire format — `TM1_RESPONSE_MODE`

Default `legacy`: a successful result ships its payload both as
`content[0].text` and as `structuredContent`. That is what the MCP spec
recommends — a tool returning structured content SHOULD also return the
serialized JSON in a text block — and it is the only shape every client can
read.

`structured` drops the text block and sends `structuredContent` alone. It halves
the wire bytes and is spec-legal because every tool declares an `outputSchema`
(`CallToolResult.content` "may be empty" then), but **a client that reads
`content[]` and ignores `structuredContent` sees no output at all.** Kiro's IDE
MCP layer is one such client.

Only turn it on when your client copies the whole `CallToolResult` into the
model prompt — Q DEV CLI / Kiro CLI do — because there the duplicate really is
paid for twice. It buys nothing on Claude Code, which de-duplicates: the same
payload sent both ways costs one copy of context, measured byte-identical at
1 KB and at 23 KB, with the oversized offload-to-file path behaving the same
either way.

`format: "markdown"` and error results are unaffected by this setting.

### `format: "markdown"` and structuredContent

Tools that take `format` send the rendered table twice: as the text block and as
`structuredContent: { "markdown": "..." }`. The JSON payload is not included —
in markdown mode the table replaces it.

This is not redundancy for its own sake. Clients disagree about which field to
read (Kiro renders `content[]`, Claude Code reads `structuredContent` and drops
`content`), so a table placed in only one of them is invisible on the other.
Before 3.1.0 the table went out in `content[]` while `structuredContent` carried
the JSON, which made `format: "markdown"` a silent no-op on Claude Code — it
showed the JSON the caller had asked not to get.

Consequence for schema consumers: the published `outputSchema` of these tools
has optional top-level fields, because it must accept both shapes and MCP output
schemas cannot express a union. Responses are still validated strictly — the
server picks the matching strict shape per response before answering.

## Secrets — `TM1_ALLOW_UNMASKED_SECRETS`

Credential masking is on by default everywhere it applies. Several tools take a
`maskSecrets` parameter, and a **model** can set it to `false` — an opt-out of a
security control chosen by the thing being guarded against. That request is
ignored unless the operator sets `TM1_ALLOW_UNMASKED_SECRETS=true`. The default
degrades to "mask anyway" rather than failing the call, so an audit still gets
its report, just redacted.

## Local file access — `TM1_LOCAL_FILE_ROOT`

Tools that read or write files on the host running the server —
`tm1_import_pro_file`, `tm1_install_pro_bundle`, `tm1_diff_process_with_file`,
`tm1_validate_process_refs`, and the git export/import pair — are **disabled by
default**. Set `TM1_LOCAL_FILE_ROOT` to an absolute directory to enable
host-path parameters; every supplied path must resolve inside that root (path
traversal is rejected).

```env
TM1_LOCAL_FILE_ROOT=/srv/tm1-git    # optional; enables host-disk file params
```

The git tools also work without it, via inline content:

- `tm1_export_process_to_git` returns `{name}.json` + `{name}.ti` inline by
  default; pass `writeToDir` (a host path under the root) to also persist them.
- `tm1_import_process_from_git` accepts `jsonContent`/`tiContent` strings, or
  `jsonPath`/`tiPath` host paths when the root is set.

### What the git round-trip preserves

The roundtrip is lossless for code, parameters, variables, datasource and
`HasSecurityAccess` (exported to the JSON file, applied on import only when
declared — otherwise the server value is preserved; also settable via
`tm1_upsert_process`). `Caption` is intentionally not roundtripped: TM1 exposes
no reliable write path for it.

The `.ti` file holds the four tabs in TM1's **native `#region <Tab>` /
`#endregion` format** (the server `Code` property) — byte-identical to
`GET /Processes('x')/Code/$value` (CRLF, empty tabs omitted); nested user folding
regions inside a tab are preserved. A malformed or unbalanced blob is rejected on
import with a clear error rather than deployed partially.

**Breaking (since the previous `### TM1-TI-TAB:` format):** `.ti` files exported
by earlier versions are no longer importable — re-export from the server to
regenerate them.

## TM1 v12 (Planning Analytics Engine)

Setting `TM1_INSTANCE` + `TM1_DATABASE` auto-selects v12: requests are rerooted
to `/{instance}/api/v1/Databases('{database}')/...` and login goes through
`POST /{instance}/auth/v1/session` instead of the v11 `/api/v1/ActiveSession`
flow. For v12, `TM1_BASE_URL` is address:port only (no path) — e.g.
`https://your-pae-host:443`.

```env
TM1_INSTANCE=my-instance
TM1_DATABASE=my-database
TM1_AUTH_MODE=s2s                   # s2s (default) | basic | access_token | oidc | iam
TM1_USER=admin                      # REQUIRED in every v12 mode (incl. s2s) — the session login "User"

# Per-mode credentials — set the ones your TM1_AUTH_MODE requires:
TM1_CLIENT_ID=my-client-id          # s2s
TM1_CLIENT_SECRET=my-client-secret  # s2s
# TM1_PASSWORD=...                   # basic (with TM1_USER)
# TM1_ACCESS_TOKEN=...               # access_token / oidc
# TM1_API_KEY=...                    # iam
# TM1_IAM_URL=https://iam.host       # iam
```

`TM1_AUTH_MODE` selects how the `auth/v1/session` request authenticates, each
with its own env vars:

| Mode            | Vars                                 | Validation status                     |
| --------------- | ------------------------------------ | ------------------------------------- |
| `s2s` (default) | `TM1_CLIENT_ID`, `TM1_CLIENT_SECRET` | **Live-validated** against PAE 12.5.9 |
| `basic`         | `TM1_USER`, `TM1_PASSWORD`           | Unit-validated request builder only   |
| `access_token`  | `TM1_ACCESS_TOKEN`                   | Unit-validated request builder only   |
| `oidc`          | `TM1_ACCESS_TOKEN`                   | Unit-validated request builder only   |
| `iam`           | `TM1_API_KEY`, `TM1_IAM_URL`         | Unit-validated request builder only   |

> Only `s2s` has been exercised against a live PAE server. The other modes'
> request builders are covered by unit tests but not yet confirmed against a
> real server — verify against your environment before relying on them.

### Tools that differ by version

`tm1_list_threads`, `tm1_cancel_thread` and `tm1_save_data` are registered on
v11 only; `tm1_list_jobs` and `tm1_cancel_job` on v12 only. v12 removed
`SaveDataAll`/`CubeSaveData` because the cloud engine persists automatically,
and replaced threads with jobs. The file service auto-falls back from the v12
`Files` root to the v11 `Blobs` root.

## CAM (Cognos Access Manager) / LDAP

Set `TM1_NAMESPACE` to your CAM namespace and the client logs in with
`Authorization: CAMNamespace base64(user:password:namespace)` — `TM1_USER` and
`TM1_PASSWORD` are still required. On PA Cloud the namespace is usually `LDAP`;
use a non-interactive service account.

Alternatively supply a pre-obtained passport via `TM1_CAM_PASSPORT`
(`Authorization: CAMPassport <token>`, no user/password needed); it takes
precedence over the namespace method. Native TM1 auth stays the default when
neither is set.

base64 is encoding, not encryption — always use `https://`. Windows SSO via
SSPI/negotiate is not supported; obtain a passport out-of-band. The CAM path has
not been validated against a live CAM server.

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

**`tm1_get_transaction_log` is slow or times out:** the TM1 transaction log is a
full scan. Always pass a tight `since` window; broad queries can hit the query
timeout. `since`/`until` are validated as ISO-8601, so ambiguous locale formats
like `08/06/2026` are rejected rather than silently read as 6 August.

**Startup error `Invalid TM1_…: expected a positive integer`:** a numeric env
var (`TM1_KEEP_ALIVE_INTERVAL`, `TM1_REQUEST_TIMEOUT`, `TM1_MCP_HTTP_PORT`) has a
non-numeric or non-positive value. Fix the value or unset it to use the default.
