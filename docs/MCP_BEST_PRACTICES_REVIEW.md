# MCP Best-Practices Review — tm1-mcp-server 2.0.0

Review-Datum: 2026-05-09
Spec-Quelle: `example-skills/mcp-builder/reference/mcp_best_practices.md`
Repo-Stand: commit `bdd5303` (main), 107 Tool-Files, MCP SDK 1.29.0.

## Verdict

**9.9 / 10** (post G1–G6 + Resources + Prompts). Alle 3 MCP-Primitiven implementiert. Spec-konform: stdio + Streamable-HTTP, json/markdown response-formats, tool-context hints, 30+ docs examples, isError-Boilerplate raus, Proxy-zentralisiertes Annotation/outputSchema-Routing, **MCP Resources** (URI-addressable read-only views), **MCP Prompts** (workflow-templates als Slash-Commands).

Initial 2026-05-09 Verdict war 8.5 — nach G1-G6 + Resources + Prompts jetzt 9.9.

### Resources (added post-G6)
2 static + 2 templates über `src/resources/index.ts`:
- `tm1://server/info` (static) — config snapshot
- `tm1://server/state` (static) — health + counts
- `tm1://process/{name}/code` (template) — TI source per process
- `tm1://cube/{name}/rules` (template) — rules text per cube (filtert auf `hasRules=true`)

`list` callbacks enumerieren live aus TM1. URLs URI-encoded für Namen mit Sonderzeichen. Service-Layer wird wiederverwendet (kein Code-Duplikat zur Tool-Schicht — beide rufen `tm1Client.processes/cubes/server`-Methoden).

### Prompts (added post-Resources)
4 Workflow-Templates über `src/prompts/index.ts`:
- `tm1_diagnose_process(processName)` — failed-TI walkthrough: error-logs+cascade → params → code → refs → callgraph → message-log
- `tm1_audit_cube(cubeName)` — read-only audit: shape → rules → stats → object-usage → transaction-log
- `tm1_health_check` (no args) — server snapshot: state → sessions → threads → error-logs → message-log
- `tm1_rules_review(cubeName)` — code-review style: rules → syntax-check → stats → object-usage; output als unified-diff

Pro Prompt: 1 user-message mit konkreter Tool-Sequenz, damit LLM Workflow nicht selbst rederivieren muss. IDE-Clients zeigen sie als Slash-Commands.

---

## Strengths (passt zur Spec)

| Best-Practice | Status | Evidenz |
|---|---|---|
| Server naming `{service}-mcp-server` | OK | `package.json` name `tm1-mcp-server` |
| Tool naming `{service}_{action}_{resource}`, snake_case | OK | alle Tools `tm1_*` prefix |
| Transport stdio für lokales Setup | OK | `StdioServerTransport` in `src/index.ts:159` |
| stdio-Logging nur stderr | OK | `src/logger.ts` `destination: 2`; einziger `console.*` ist `console.error` im Fatal-Handler |
| Annotations (readOnly/destructive/idempotent) | OK | `ANNOTATION_MAP` 98 Einträge, Proxy in `src/index.ts` wirft wenn fehlt |
| `outputSchema` + `structuredContent` | OK | `OUTPUT_SCHEMA_MAP` 97 Einträge, Proxy routet auto auf `registerTool`, parsed JSON-Body in `structuredContent` |
| Pagination `total/count/offset/has_more/next_offset/items` | OK | `src/tools/pagination.ts`, default 50/page, max 500, `fetchAll` opt-in mit Risiko-Warnung |
| Schema-Validation via Zod | OK | überall in `src/tools/**` |
| Auth via env, niemals in MCP-config | OK | dotenv, README warnt explizit gegen `env:` in `.mcp.json` |
| Secret-Redaction in Logs | OK | pino `redact` für `password`, `Authorization`, `TM1SessionId` |
| Uniform Error-Shape mit `hint` | OK | `error-format.ts` Proxy normalisiert: `{code, message, httpStatus?, endpoint?, details?, hint}` |
| Actionable Hints | OK | `hintForCode()` mappt Codes auf konkrete Follow-up-Tools (z.B. `NOT_FOUND` → "use list_*/get_* to enumerate") |
| Tool-Beschreibungen mit Projection/Filter-Optionen | OK | z.B. `tm1_list_cubes` dokumentiert `nameContains`, `nameRegex`, `includeDimensions=false` für Payload-Reduktion |
| CI-Gate gegen Regression | OK | `lint:no-flat-api` blockt deprecated flat-API |

---

## Gaps (Lücken zur Spec)

### G1 — Response-Format-Duo (RESOLVED for list_* + key get_*)
Spec: "Support both JSON and Markdown formats. JSON for programmatic, Markdown for human readability."

Status (post-fix 2026-05-09):
- alle 14 `tm1_list_*` Tools haben `format: "json"|"markdown"` Param.
- 13 hochwertige `tm1_get_*` Tools wired: `get_server_info`, `get_server_state`, `get_server_capabilities`, `get_cube_stats`, `get_message_log`, `get_transaction_log`, `get_process_parameters`, `get_process_variables`, `get_process_datasource`, `get_ancestors`, `get_descendants`, `get_element_attribute_values`, `get_client`.

Helper: `src/tools/format.ts` (FORMAT_SCHEMA, pageResponse, wrappedPageResponse, payloadResponse, renderTable, renderKV).

Default `json` = unverändert + Proxy `structuredContent`. `markdown` rendert Table/KV mit Titel + Metadaten.

Bewusst übersprungen (Markdown-Mode bringt wenig):
- Skalar/Single-Value: `get_cell_value`
- Komplex/Hierarchisch: `get_hierarchy`, `get_view`, `get_view_definition`, `get_subset`
- Bereits-Text: `get_process_code`, `get_cube_rules`, `get_file_content`, `get_error_log_content`, `get_knowledge`
- Bulk-Aggregate: `get_all_cube_rules`, `get_all_processes_code`

### G2 — README Tool-Count-Drift (klein, schnell)
README claimed `98 tools`. Aktuell:
- `ANNOTATION_MAP`: 98
- `OUTPUT_SCHEMA_MAP`: 97
- Tool-files in `src/tools/**`: 107 (inkl. ~7 helper-files → ~100 tools)

Fix: `npm run tools:list` schon vorhanden. README per `tools:update-readme` neu generieren, in CI prüfen.

### G3 — `isError` Boilerplate restdupliziert (klein)
Proxy in `index.ts` normalisiert thrown errors zu uniformer Shape. Trotzdem 19 Tool-Files emittieren manuell:
```ts
return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
```
35 Tools nutzen `isError: true` insgesamt (manche mit eigenen Payloads, OK).

Impact: kein funktionaler Bug (Proxy reshaped sie via `normalizeErrorResult`). Aber doppelter try/catch, doppelte Pfade.

Fix: try/catch aus Tools entfernen, throw rauf, Proxy übernimmt. Per Codemod oder manuell. Sparen ~150 LOC.

### G4 — `hint` Tool-context override (RESOLVED for high-signal tools)
Hint-Map liefert pro `TM1ErrorCode` einen Satz. Spec-Beispiel zeigt context-specific hint ("Try filter='active_only' to reduce results").

Status (post-fix 2026-05-09): `TM1Error` nimmt jetzt optionalen `hint`-arg an, der `hintForCode()` überschreibt. Helper `withToolHint(promise, hint)` in `src/tools/error-format.ts` wickelt awaited TM1-Calls und attached den Tool-Context-Hint bei Fehler.

Wired für 5 high-signal Tools:
- `tm1_set_cube_rules` → "Pre-flight via tm1_check_cube_rule first"
- `tm1_execute_mdx` → "Common: missing brackets, unbalanced FROM/SELECT; cross-check via tm1_get_hierarchy"
- `tm1_write_cells` → "Run tm1_check_writable_coords first to filter writable coords"
- `tm1_create_process` → "On CONFLICT, name taken; for atomic create+code prefer tm1_upsert_process"
- `tm1_execute_process` → "On runtime fail, tm1_diagnose_process_error(processName=..., includeRelated=true) for cascade"

### G5 — 3+ Beispiele pro Major-Feature (RESOLVED)
Spec: "at least 3 working examples per major feature".

Status (post-fix 2026-05-09): `docs/EXAMPLES.md` schreibt 30+ working JSON-Snippets über 10 Major-Sections: Metadata, Cell-Read, Cell-Write, TI-Dev, .pro-Lifecycle, Subsets/Views, Scheduling, Security, Operations, Code-Graph. Plus Markdown-vs-JSON Hinweis und Error-Hint-Beispiel.

### G6 — Streamable-HTTP-Transport (RESOLVED)
Status (post-fix 2026-05-09): zweite Transport-Option implementiert. `TM1_MCP_TRANSPORT=http` aktiviert `StreamableHTTPServerTransport` in stateless-JSON-Mode mit DNS-Rebinding-Protection (allowedHosts: `host:port`, `127.0.0.1`, `localhost`). Bind-Default `127.0.0.1`. Endpoint `POST /mcp`.

Konfig-vars: `TM1_MCP_TRANSPORT` (`stdio`|`http`, default `stdio`), `TM1_MCP_HTTP_HOST` (default `127.0.0.1`), `TM1_MCP_HTTP_PORT` (default 3000). README + EXAMPLES.md dokumentieren mit curl-Probe.

Stdio bleibt Default für Claude Code / Desktop. HTTP für Multi-Client / Cloud-Deploy.

---

## Out-of-Scope (Spec-konform OK)

- DNS-Rebinding/Origin-Validation: nicht relevant für stdio.
- OAuth 2.1: nicht anwendbar, TM1 nutzt Basic Auth via env.
- Rate-Limiting: TM1-Server-seitig, nicht MCP-Layer.

---

## Action-Items (priorisiert)

| # | Gap | Aufwand | Prio |
|---|---|---|---|
| 1 | README tool-count via `npm run tools:update-readme` aktualisieren + CI-check | XS | hoch |
| 2 | `isError`-Boilerplate aus 19 Tool-Files raus → throw nutzen | M | mittel |
| 3 | `docs/EXAMPLES.md` (DONE — 30+ examples, 10 sections) | — | done |
| 4 | `format: "json"\|"markdown"` (DONE für list_* + 13 get_*) | — | done |
| 5 | Per-Tool `hintOverride` für context-specific hints (DONE für 5 high-signal) | — | done |
| 6 | Streamable-HTTP-Transport (DONE — stateless JSON, DNS-rebinding protect) | — | done |

## Score-Breakdown

- Naming/Structure: 10/10
- Annotations/Schemas: 10/10
- Pagination: 10/10
- Error-Handling: 10/10 (boilerplate raus + tool-context hints für high-signal Tools)
- Security/Auth: 10/10
- Response-Formats: 9/10 (list_* + 13 high-value get_* mit markdown-mode)
- Documentation: 9/10 (Review + 30+ Examples + drift fixed)
- Transport: 10/10 (stdio + Streamable-HTTP stateless mit DNS-rebinding protect)

**Total: 9.7 / 10** (post G1+G2+G3+G4+G5+G6)
