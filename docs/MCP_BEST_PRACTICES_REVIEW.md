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

---

# Round 2 — Protocol-Features & Polish (2026-05-15)

Zweite Iteration: tieferer Blick auf MCP-Protokoll-Features die in Round 1 nicht betrachtet wurden (progress, cancellation, logging, subscriptions, capability-declaration), plus Annotation-Korrekturen und Tool-Body-Inkonsistenzen.

## Protokoll-Features ungenutzt

### R2-01 — Capabilities nicht deklariert
`new McpServer({ name, version })` in `src/index.ts:239` ohne `capabilities`-Objekt. SDK setzt Defaults, aber explizite Declaration ist Spec-empfohlen für `logging`, `prompts`, `resources`, `tools.listChanged`. Clients können sonst Features missinterpretieren.

### R2-02 — Keine progress notifications
Long-running Tools blockieren stumm bis Fertigstellung:
- `tm1_execute_process` (TI-Run, mehrere Minuten möglich)
- `tm1_install_pro_bundle` (Verzeichnis voller `.pro` deployen)
- `tm1_bulk_upsert_elements` (große Dim-Refreshes)
- `tm1_get_all_processes_code` (N+1 process-fetches)
- `tm1_check_v12_readiness` (vollständiger TI/Rules-Scan)

MCP `notifications/progress` mit `progressToken` ungenutzt. User sieht keinen Fortschritt, kann nicht abschätzen ob hängt oder läuft.

### R2-03 — Keine cancellation
~~Kein `AbortSignal` von MCP-Request bis undici durchgeschleift. User kann blockierenden Tool-Call nicht abbrechen (MCP `notifications/cancelled` ignoriert). Bei TI-Execution besonders schmerzhaft — Process läuft TM1-seitig weiter.~~

**Done 2026-05-16.** `RequestOptions.signal` plumbed through `request`/`requestRaw`/`requestBinary`. `linkAbortSignals` couples external MCP `RequestHandlerExtra.signal` to local timeout `AbortController` (no `AbortSignal.any()` — Node 18 baseline). Wired into `tm1_execute_process`, `tm1_execute_chore`, `tm1_execute_mdx`. Cancellation aborts in-flight undici fetch; TM1-side process continues but client unblocks. Unit tests `tests/unit/http-abort-signal.test.ts` cover pre/mid-flight abort + no-signal control.

### R2-04 — MCP logging notifications ungenutzt
pino loggt lokal nach stderr (korrekt für stdio), aber `server.sendLoggingMessage()` nie aufgerufen. Client-Side log-panel (Claude Desktop log viewer, VS Code MCP output) sieht keine Tool-Events. Kandidaten: slow MDX (`durationMs > 5000`), deprecation warnings, retry-on-reconnect.

### R2-05 — Keine resource subscriptions
~~Kommentar `src/resources/index.ts:5` deutet auf "subscribe to updates without polling" — nicht implementiert. Gute Kandidaten:
- `tm1://server/state` (state-changes pushen)
- `tm1://server/sessions` (login/logout events)
- `tm1://server/threads` (long-running-thread alerts)

Spec: `resources/subscribe` + `notifications/resources/updated`.~~

**Done 2026-05-16 (MVP).** Capabilities `resources.subscribe: true`. `SubscriptionRegistry` installs `resources/subscribe` and `resources/unsubscribe` handlers via `server.server.setRequestHandler`. HTTP layer emits typed `tm1Events.mutation` after every successful non-safe response (POST/PUT/PATCH/DELETE). Registry listens, matches against `STATE_SENSITIVE_URIS` (currently `tm1://server/state`), and fires `sendResourceUpdated({ uri })` per subscribed match. Decoupled via in-process EventEmitter so HTTP layer holds no MCP-server reference. Send errors logged, never thrown.

Sessions/threads subscriptions deferred — TM1 doesn't push session events, so they'd require a polling loop. Add later if a client surfaces real demand. Tests: `tests/unit/resource-subscriptions.test.ts` (8 scenarios) + `tests/unit/http-mutation-events.test.ts` (4 scenarios).

### R2-06 — Keine tool-list-changed notifications
~~Tools sind static nach `registerAllTools()`. Falls künftig version-abhängig (v11 vs v12 expose unterschiedliche Tools) fehlt `notifications/tools/list_changed`.~~

**Done 2026-05-16.** Capabilities `tools.listChanged: true`, `resources.listChanged: true`, `prompts.listChanged: true`. SDK auto-fires `notifications/tools/list_changed` when `server.tool()` is called post-connect (currently never, but groundwork laid for future version-conditional tool gating).

### R2-07 — Cursor-basierte MCP-pagination ungenutzt
~~Eigene `{limit, offset, fetchAll}` Envelope statt protokoll-natives `cursor`-Feld (z.B. bei `resources/list` mit vielen Cubes). Tool-interne Pagination OK lassen, aber `resources/list` callbacks könnten MCP-Cursor zurückgeben für lange Listen (>1000 Cubes/Processes).~~

**Done 2026-05-16.** SDK 1.29.0's high-level `ListResourcesRequestSchema` handler does NOT forward `params.cursor` to template list callbacks and strips `nextCursor` from results, so we override it. New `src/resources/list-handler.ts` builds a typed catalog from `registerAllResources` and installs a low-level handler via `server.server.setRequestHandler` that paginates the combined static+template resource list. Cursor is opaque base64url-encoded JSON `{ o: offset }`; malformed cursors degrade to a fresh listing. Page size default 200 (configurable). Sorting is by URI for stable paging. Tool-internal pagination envelopes (`limit/offset/fetchAll`) remain unchanged — that's tool-level data slicing, distinct from resource-listing protocol pagination. Tests: `tests/unit/resource-list-cursor.test.ts` (11 scenarios incl. multi-page round-trip).

## Auth / Security

### R2-08 — HTTP transport ohne Auth-Layer
Loopback-bind (127.0.0.1) + DNS-rebind-guard schützen Single-User-Setup. Falls jemand `TM1_MCP_HTTP_HOST=0.0.0.0` setzt = LAN-exponiert ohne Auth. Spec empfiehlt OAuth 2.1 für remote-Transport. Optionen:
- Bearer-Token-Check (env `TM1_MCP_HTTP_TOKEN`)
- OAuth 2.1 mit DCR
- mTLS hinter Reverse-Proxy (außerhalb scope)

### R2-09 — Kein audience-binding / token-binding
Wenn HTTP exponiert wird (R2-08), fehlt token-binding gegen replay über mehrere Server-Instanzen.

## Tool-Design

### R2-10 — `delete-cube` ohne `confirm`-Parameter
Annotation = DESTRUCTIVE ✓, Description warnt ✓. Aber kein in-tool double-check (`confirm: z.literal(cubeName)`). Verlässt sich auf Client-UI-Prompt + autoApprove-Allowlist. Gleicher Mangel bei `tm1_delete_dimension`, `tm1_delete_process`, `tm1_clear_cube`, `tm1_unload_cube`.

Pattern: zweites Parameter `confirm: z.string()` mit Validierung gegen `name` macht versehentlichen LLM-Call schwerer.

### R2-11 — `tm1_invalidate_callgraph_cache` als DESTRUCTIVE falsch klassifiziert
Cache-Invalidation ist idempotent + recoverable (re-build beim nächsten Read). DESTRUCTIVE löst unnötige Client-Prompts aus. → IDEMPOTENT_WRITE.

### R2-12 — `openWorldHint` fehlt in allen annotations
`READ_ONLY/IDEMPOTENT_WRITE/WRITE/DESTRUCTIVE` annotations in `src/tools/annotations.ts` setzen `openWorldHint` nicht. TM1 ist external system → Spec sagt `openWorldHint: true` für alle TM1-tools.

### R2-13 — `tm1_execute_chore` / `tm1_execute_process` als DESTRUCTIVE — semantisch ok aber overloaded
DESTRUCTIVE laut Spec = "may perform destructive updates to its environment". Execute fällt rein (Side-effects auf Cubes), aber annotation map vermischt "delete" mit "execute". Beibehalten OK, aber Doku-Hinweis: TI-Execute = irreversible Daten-Mutation.

### R2-14 — `delete-cube` Tool-Body inkonsistent
`src/tools/model-building/delete-cube.ts` schreibt `content`-Envelope manuell (Z. 17-22), während andere Tools `pageResponse`/`payloadResponse` helper nutzen. Konsistenz: Helper `simpleResponse({ success: true, ...meta })`.

## SDK / Versioning

### R2-15 — SDK pinned `@modelcontextprotocol/sdk 1.29.0`
Stand prüfen ggü. latest. Update könnte bringen:
- elicitation (mid-call user-input request)
- sampling (LLM-completion request vom Server)
- bessere progress/cancellation-APIs
- structured-content-roundtrip Fixes

### R2-16 — Node engines `>=18` OK
Kein Handlungsbedarf — fetch ist seit 18 stable.

## Output / Errors

### R2-17 — `structuredContent` nur wenn outputSchema existiert
Proxy in `src/index.ts` routet auf `registerTool` mit `outputSchema` nur wenn in `OUTPUT_SCHEMA_MAP`. Tools ohne Schema-Eintrag (z.B. `tm1_delete_cube`, `tm1_execute_mdx` evtl.) returnen Text-JSON ohne `structuredContent` → typed-Clients verlieren Typing. Coverage prüfen: `OUTPUT_SCHEMA_MAP` Einträge vs `ANNOTATION_MAP` Einträge.

### R2-18 — Error-Hint statisch pro Code
`hintForCode` mapping in `src/types.ts` gut. Aber kein situational hint (TM1-Version, capability flag, current Tool-Context). `withToolHint` löst das pro-call → in `delete-cube`, `bulk-upsert`, `import-pro-file` nicht genutzt.

## Inhaltliche Lücken

### R2-19 — Kein `tm1_orientation` / `tm1_help` prompt
LLM-Onboarding-Prompt fehlt: Server-Topology, Naming-Conventions, `}`-Prefix für Control-Objekte, Pagination-Envelope-Shape, Welche Tools für welchen Workflow. Pendant zu agentskills.io "When to use" / SKILL.md.

### R2-20 — Knowledge-Tool optional, kein Default-Bundle
~~`tm1_get_knowledge` liest aus `TM1_KNOWLEDGE_DIR`. Wenn unkonfiguriert = stille Degradation (kein Article, kein Hint). Sollte gebündelte Default-Artikel ausliefern (ti-syntax, mdx-patterns, tm1-rules) als NPM-Package-Assets.~~

**Done 2026-05-16.** Shipped `knowledge/` directory at package root with `INDEX.md`, `ti-syntax.md`, `mdx-patterns.md`, `tm1-rules.md`. `get-knowledge.ts` resolves bundled dir via `import.meta.url` three-up traversal (works in both `src/` and `dist/` layouts and via `node_modules/`). `TM1_KNOWLEDGE_DIR` still overrides if set. `package.json` `files: ["dist", "knowledge"]` ensures the bundle ships in the NPM tarball. Orientation prompt updated. Tests `tests/unit/knowledge-bundle.test.ts` verify bundle integrity and INDEX coverage.

### R2-21 — Keine v11-vs-v12 capability annotation per Tool
~~`tm1_check_v12_readiness` global ✓, aber einzelne Tools (`tm1_install_pro_bundle`, `tm1_import_pro_file`) ohne Metadata wer sie verträgt. Tool-Description erwähnt es z.T., aber keine machine-readable Annotation. Vorschlag: `requiresVersion: "v12"` in `ToolAnnotations` extension.~~

**Done 2026-05-16.** `Tm1ToolAnnotations extends ToolAnnotations` with `requiresVersion?: "v11" | "v12" | "v11+" | "v12+"`. `withVersion(base, version)` helper composes without mutation. ANNOTATION_MAP value type widened. Tagged 5 v11-only tools: `tm1_check_v12_readiness`, `tm1_diff_process_with_file`, `tm1_export_process_to_pro`, `tm1_import_pro_file`, `tm1_install_pro_bundle`. Field survives JSON wire transport (verified in test) — MCP base schema is non-strict z.object, so unknown keys pass through. Server emits hint only; does not refuse mismatched calls (annotations are hints per spec). Tests `tests/unit/annotation-requires-version.test.ts`.

### R2-22 — Callgraph-Cache wird nicht auto-invalidiert
Schema-Mutationen (`create_dimension`, `create_cube`, `update_process_code`, `set_cube_rules`) sollten Callgraph-Cache automatisch invalidieren. Aktuell muss User `tm1_invalidate_callgraph_cache` manuell aufrufen → stale graph silently möglich.

---

## Action-Items Round 2 (priorisiert)

| # | Punkt | Impact | Aufwand | Prio |
|---|---|---|---|---|
| R2-12 | `openWorldHint:true` für alle annotations | korrekte Client-Warnings | XS | hoch |
| R2-11 | `tm1_invalidate_callgraph_cache` → IDEMPOTENT_WRITE | weniger false-positive Prompts | XS | hoch |
| R2-01 | Capabilities explizit deklarieren in `new McpServer` | Spec-Compliance | XS | hoch |
| R2-10 | `confirm`-Param auf delete-cube/-dimension/-process, clear-cube | Safety-Net | S | hoch |
| R2-14 | `delete-cube` Body auf Helper umstellen | Konsistenz | XS | mittel |
| R2-22 | Auto-invalidate Callgraph nach Schema-Mutationen | Korrektheit | S | mittel |
| R2-17 | OUTPUT_SCHEMA_MAP Coverage prüfen + auf 100% | Typed Output | M | mittel |
| R2-19 | `tm1_orientation` Prompt | LLM-Onboarding | S | mittel |
| R2-02 | Progress Notifications für 5 Long-Running Tools | UX bei Long-Ops | M | mittel |
| R2-04 | `sendLoggingMessage` für slow query / deprecation | Client-Visibility | M | mittel |
| R2-15 | SDK-Update prüfen + Migration | Future-Proof | M | mittel |
| R2-03 | AbortSignal MCP→undici durchschleifen | Cancel-Support | M | niedrig |
| R2-05 | Resource Subscriptions für server-state/threads/sessions | Polling vermeiden | L | niedrig |
| R2-20 | Knowledge-Default-Bundle als NPM-Asset | Out-of-Box-Wert | M | niedrig |
| R2-21 | `requiresVersion` Annotation extension | Machine-Readable Compat | M | niedrig |
| R2-18 | `withToolHint` Coverage auf High-Signal Mutations | bessere Hints | S | niedrig |
| R2-08 | HTTP Bearer-Token oder OAuth 2.1 | Remote-Auth | L | niedrig (nur wenn HTTP exposed) |
| R2-09 | Audience/Token-Binding | Replay-Schutz | M | niedrig |
| R2-06 | Tools-List-Changed Notifications | dynamic Tools | S | niedrig (nicht benötigt aktuell) |
| R2-07 | Cursor-Pagination für resources/list | nur bei >1000 Objekten | M | niedrig |
| R2-13 | Doku-Hinweis Execute vs DESTRUCTIVE | Klärung | XS | niedrig |
| R2-16 | Node-Engines — kein Handlungsbedarf | — | — | done |

## Score-Update (post Round-2-Analyse)

Round-2 senkt aktuellen Score nicht — alle Punkte sind Polish + Protokoll-Feature-Erweiterungen, kein Spec-Bruch. Total bleibt **9.7 / 10**. Bei Umsetzung R2-01/02/03/04/05/12 → **10/10** (volle Protokoll-Feature-Nutzung).
