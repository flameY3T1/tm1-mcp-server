# TM1 MCP Tool Audit — Konsolidierungs-Vorschläge

Stand: 2026-05-26. Diskussions-Entwurf — nicht alle Punkte sind beschlossen.

**Scope ursprünglich:** 105 Tools über 13 Kategorien.
**Aktueller Stand:** 107 Tools über 12 Kategorien (102 nach Drops vom 2026-05-26;
+`tm1_save_data`, +3 Feeder-/Cell-Tracing-Tools am 2026-06-06,
+`tm1_get_audit_log`, +`tm1_create_native_view` am 2026-06-07, siehe `GAP_ANALYSIS.md`).
Server hat zusätzlich MCP **Prompts** (`tm1_orientation`) + MCP **Resources**
(`tm1://...` URIs) als alternative Endpoints für read-only Daten und Workflow-Templates.

---

## Klassifizierung

| Tier | Bedeutung | Aktion |
|------|-----------|--------|
| ✅ KEEP | Atomar, einzigartig, hoher Wert | nichts tun |
| 🟡 MERGE | Überschneidung mit Nachbar → ein Tool mit Param | konsolidieren |
| 🔵 SKILL | Workflow / Composite / statischer Content → besser als Skill oder Prompt | rausziehen |
| 🔴 DROP | redundant, niche, durch existierendes ersetzt | entfernen oder zu internem Helper degradieren |

> **Hinweis:** User stimmt nicht mit allen Punkten überein — TODO an Ende klären.

---

## 1) 🟡 MERGE — Duplikate konsolidieren

| Konflikt | Vorschlag |
|---|---|
| ~~`tm1_resolve_default_member` (1x) + `_members` (1–64)~~ | ~~Singular droppen — Plural akzeptiert N=1~~ — **verworfen 2026-05-27**, beide behalten (Output-Shape + Error-Semantik divergieren, analog `list_processes` Entscheidung) |
| ~~`tm1_list_processes` + `_grouped`~~ | ~~Merge via `groupBy?` Param~~ — **verworfen**, beide behalten (siehe §7) |
| TI-Einzel-Tools vs. `upsert_process` (5 Tools: `create_process`, `update_process_code/parameters/variables/datasource`) | **Linie B umgesetzt** — alle 5 ersatzlos durch `upsert_process` abgedeckt (✅ 2026-05-26, siehe §7) |
| `tm1_get_cube_rules` vs `get_all_cube_rules` | beide behalten (Single-Object vs Map-Return verschieden) |
| `tm1_check_process_code` vs `compile_process` | beide behalten (lokal vs server-side, Beschreibung schärfen) |

Netto: 5 Tools weg (Linie B). Resolve-Singular bleibt (Shape-Divergenz).

---

## 2) 🔵 SKILL-Kandidaten — kein TM1-Roundtrip nötig

| Tool | Begründung | Migration |
|---|---|---|
| ~~`tm1_check_v12_readiness`~~ | ~~Compound aus naming + complexity + pattern-grep~~ | **verworfen 2026-05-27** — Tool hat eigenen Scanner (`v12-compat/scanner.ts`, Ruleset `vscode-tm1-ti@cf73b93`), nicht trivial aus `audit_naming` + `audit_complexity` rekonstruierbar. Behalten. |
| `tm1_diagnose_process_error` | Workflow: list_logs → get_content → siblings | Hybrid: Tool für Latenz behalten + MCP-Prompt zusätzlich registrieren |
| ~~`.pro`-Lifecycle (`import_pro_file` / `export_process_to_pro` / `install_pro_bundle` / `diff_process_with_file`)~~ | ~~Atomare Bausteine, aber 3-stufiger Standardworkflow~~ | **verworfen 2026-05-27** — Workflows theoretisch, kein realer Bedarf. Atome reichen. |

---

## 3) 🔴 DROP — komplett raus

- ~~`tm1_resolve_default_member` (durch Plural)~~ — **verworfen 2026-05-27**, Shape + Error-Semantik divergieren
- ~~`tm1_list_processes_grouped`~~ — **verworfen**, beide behalten (siehe §7)
- ~~`tm1_get_process_variables` / `_parameters`~~ — **erweitert zu Linie B (siehe nächster Punkt)**
- **Linie B (5 Tools):** `tm1_create_process`, `tm1_update_process_code`, `tm1_update_process_parameters`, `tm1_update_process_variables`, `tm1_update_process_datasource` — **ersatzlos**, alle abgedeckt durch `tm1_upsert_process` (✅ umgesetzt 2026-05-26)
- ~~`tm1_check_v12_readiness` (→ Skill `tm1-v12-migration`)~~ — **verworfen 2026-05-27**, dedizierter Scanner mit eigenem Ruleset, behalten
- `tm1_get_knowledge` — **ersatzlos**, Skill `tm1-knowledge` deckt ab (✅ umgesetzt 2026-05-26, commit `be5cbe7`)

Netto: 6 Tools weniger → 102. Audit-Backlog abgeschlossen. (`tm1-deploy-pro`, `tm1-v12-migration` Skill, Singular-Drop alle verworfen 2026-05-27.)

---

## 4) ✅ KEEP — nicht anfassen

Atomar + einzigartig:
- `tm1_check_writable_coords` — pre-write validation
- `tm1_validate_process_refs` — cube/dim resolve
- `tm1_upsert_process` — Atomic-Bundle, ersetzt N-step deploy
- `tm1_sample_cells` — sparse-aware view sampler
- `tm1_search_code` / `tm1_search_files` — beide unterschiedliche Scopes
- `tm1_diff_process_with_file` — Lifecycle-Baustein
- Alle CRUD-Atome (cube/dim/element/chore/client/subset/view)
- Alle Live-Audit-Tools: `audit_complexity/feeders/naming`, `analyze_callgraph/object_usage/chore_graph`, `find_orphan_dimensions`

---

## 5) Empfohlene Reihenfolge

1. **Phase 1 (klein, sofort):**
   - `tm1_get_knowledge` (✅ umgesetzt) — Skill bereits vorhanden
   - **Linie B** (✅ umgesetzt) — 5 atomic process write tools durch `upsert_process` ersetzt
   - ~~`tm1_resolve_default_member` (Singular)~~ — **verworfen 2026-05-27**, beide behalten
2. ~~**Phase 2:** `tm1-v12-migration` Skill bauen → `check_v12_readiness` Tool droppen~~ — **verworfen 2026-05-27**, Tool hat eigenen Scanner, behalten
3. ~~**Phase 3:** `tm1-deploy-pro` Skill als Workflow-Composer für `.pro`-Lifecycle~~ — **verworfen 2026-05-27** (theoretischer Bedarf, kein realer Use-Case)

---

## 6) Lifecycle-Tags (Doku-Empfehlung)

Frequenz in tool descriptions:
- **HOT** (täglich): `list_*`, `execute_mdx`, `write_cells`, `get_process_code`, `upsert_process`, `execute_process`, `audit_*`
- **WARM** (wöchentlich): `create_*` (cube/dim/element/chore/client/subset/view), `validate_process_refs`, `diagnose_*`
- **COLD** (admin/selten): `clear_cube`, `unload_cube`, `invalidate_callgraph_cache`, `cancel_thread`, `list_sessions`

LLM priorisiert besser wenn Frequenz explizit.

---

## 7) Offene Punkte / TODO

Entscheidungen aus User-Review:

- [x] `tm1_get_knowledge` → **ersatzlos droppen** (Skill `tm1-knowledge` existiert bereits, basiert auf gleichem Inhalt; kein Fallback für Nicht-Claude-Clients nötig). Umgesetzt 2026-05-26, commit `be5cbe7`. Bundle `knowledge/` + `package.json files`-Eintrag ebenfalls entfernt.

- [x] `tm1_list_processes_grouped` → **NICHT mergen, beide behalten**

  **Begründung — Output-Shapes divergieren strukturell:**

  | | `list_processes` (flat) | `list_processes_grouped` |
  |---|---|---|
  | Response | `{total, count, offset, has_more, next_offset, items[]}` Pagination-Envelope | `{totalProcesses, groupCount, prefixSegments, groups[]}` ohne Pagination |
  | Row-Shape | `{name, parameters?}` | `{prefix, count, processes?}` |
  | Filter | `nameContains`, `nameRegex`, `nameNotContains`, `excludePattern` | nur `excludePattern` |
  | Projection | `fields=['name']` für skinny payload | n/a |
  | Pagination | `limit/offset/fetchAll` | komplett nicht (groups bleiben klein) |

  Merge über `groupBy?`-Param würde **conditional return type** erzwingen:
  - `output-schema-map.ts` müsste `z.union` registrieren → Caller muss
    `if (response.items) … else …` discriminieren
  - Output-Validierung wird unklarer (discriminated union statt einfache Shape)
  - Filter-Semantik divergiert (grouped pre-filtert vor Aggregation, flat
    post-filtert pro Page)

  Sauberer Output-Contract pro Tool > Tool-Count-Einsparung. Vergleichbarer
  Trade-off wie bei `get_cube_rules` vs `get_all_cube_rules` (auch beide behalten).

- [x] **Linie B** — 5 TI-Einzel-Tools durch `upsert_process` ersetzt (umgesetzt 2026-05-26):
  - Dropped: `tm1_create_process`, `tm1_update_process_code`, `tm1_update_process_parameters`, `tm1_update_process_variables`, `tm1_update_process_datasource`
  - Read-Atome (`tm1_get_process_code/datasource/variables`, `tm1_get_process_parameters`) bleiben — atomic reads ohne Schreib-Pfad-Redundanz

  **Begründung:**
  - `upsert_process` deckt alle 5 Operationen via optionale Felder (`prolog`/`metadata`/`data`/`epilog`, `parameters`, `variables`, `dataSource`) + `mode: 'create'|'update'|'upsert'`
  - LLM lernt **eine** Schreib-Operation für TI (mental model klarer)
  - Atomic-bundle Trail (`appliedSteps[]`) → Failure-Reporting steht
  - Pattern-Bruch zu `create_cube`/`create_dimension`/etc. bewusst akzeptiert: TI hat 5 Sub-Resources, Cube/Dim nicht — Asymmetrie inhaltlich begründbar
  - **Latenz-Trade-off:** `upsert` macht `processes.list()` für Existenzcheck → ~50–500ms Overhead pro Update. Akzeptiert für sauberere Tool-Surface.

  **Mitgeändert:**
  - `tm1_check_process_code` Description (verweis auf `upsert_process`)
  - `tm1_import_pro_file` Recovery-Hints (Param/Variable/Datasource Failure → re-run `upsert_process`)
  - Output-Schema-Map + Annotation-Map Entries entfernt
  - Test-Suites (`output-schema-map.test.ts`, `output-schema-additional-properties.test.ts`) angepasst

- [x] **Linie C** — `tm1_get_server_capabilities` → `tm1_get_server_info` gemerged (umgesetzt 2026-05-26):
  - Dropped: `tm1_get_server_capabilities`
  - `tm1_get_server_info` jetzt curated grouped output (modelling/ti/rules/mtq/jobQueuing/memory/logging/http/security) + `_raw` für Power-User-Pfade
  - `tm1_get_server_state` bleibt — counts + connection-flag sind unique

  **Begründung:**
  - Beide Tools holten aus identischer Quelle (`/Configuration` + `/ActiveConfiguration` via `info.extra`) — `capabilities` war reine Curation-Layer ohne eigene API-Call
  - Agent musste raten welches Tool für welchen Flag → mental model unnötig fragmentiert
  - `info` als Single-Source-Of-Truth für TM1 cfg, `state` als Health-Snapshot
  - `_raw` escape-hatch verhindert breaking change für tief-pulende Konsumenten

  **Mitgeändert:**
  - `ServerCapabilitiesResultSchema` gelöscht; `ServerInfoSchema` extended (modelling/ti/rules/mtq/jobQueuing/memory/logging/http/security + `_raw`)
  - Output-Schema-Map + Annotation-Map Entries entfernt
  - Prompts (`src/prompts/index.ts:83,194`) auf `tm1_get_server_info` umgezogen
  - Test (`output-schema-map.test.ts`) Entry entfernt
  - Plan-Dokument: `docs/plans/server-info-consolidation.md`

- [x] `tm1_resolve_default_member` (Singular) → **NICHT droppen, beide behalten** (verworfen 2026-05-27)

  **Begründung — Output-Shape + Error-Semantik divergieren:**

  | | Singular | Plural |
  |---|---|---|
  | Input | `{dimensionName, hierarchyName?}` | `{items: [{...}]}` 1–64 |
  | Output | flat result | `{results: [...]}` |
  | Errors | wirft (try/catch) | embedded `.error` pro item, call wirft nie |
  | Parallelism | n/a | `Promise.allSettled` |

  Drop würde N=1 Caller zwingen: Input-Array-Wrap + Output-`results[0]`-Unwrap + Error-Handling-Wechsel (catch → `.error`-Check). Pattern-Konsistenz mit `list_processes` / `_grouped` Entscheidung (auch beide behalten wegen Shape-Divergenz).

- [x] View-Tools (5x) → **NICHT mergen, alle 5 behalten** (verworfen 2026-05-27)

  **Begründung — 5 disjunkte REST-Endpoints + Verbs:**

  | Tool | Zweck | Endpoint |
  |---|---|---|
  | `tm1_get_view` | execute view, return cells | POST `…/Views('y')/tm1.Execute` |
  | `tm1_get_view_definition` | Struktur only (MDX ODER NativeView axes), keine Execution | GET `…/Views('y')?$expand=…` |
  | `tm1_list_views` | Inventar (public+private), paginated, MDX snippet | GET `…/Cubes('x')/Views,PrivateViews` |
  | `tm1_create_mdx_view` | persistiert MDX view | POST `…/Cubes('x')/Views` |
  | `tm1_delete_view` | löscht public view | DELETE `…/Views('y')` |

  `get_view` ⇆ `get_view_definition`: execute vs inspect — Definition spart Cells-Download bei großen Views (Cross-Ref bereits in Description). `list_views` ⇆ `get_view_definition`: Inventar-Snippet vs Full-Detail. CRUD-Pattern (`create_*` / `delete_*`) konsistent mit `delete_cube` / `delete_dimension` / `delete_process`.

- [x] `tm1_list_sessions` ⇆ `tm1_list_threads` → **NICHT mergen, beide behalten** (verworfen 2026-05-27)

  **Begründung — distinkte REST-Endpoints, komplementäre Workflows:**

  | | `list_sessions` | `list_threads` |
  |---|---|---|
  | Endpoint | `/Sessions?$expand=Threads,User` | `/Threads` |
  | Shape | session-zentriert, nested threads, `active` flag + User | flat workload-list, inkl. System/Chore/External threads |
  | Felder | `lockType`, `waitTime`, per-thread `info` | `context`, `elapsedTime` |
  | Use-Case | "wer ist verbunden" | "was läuft gerade" |

  Threads-Endpoint enthält Workloads ohne Session (Chore-Runs, System-Threads) — kein Subset von Sessions-Expand.

- [x] `tm1_check_v12_readiness` → **NICHT droppen, behalten** (verworfen 2026-05-27)

  **Begründung — dedizierter Scanner, kein Compound:**
  - `src/lib/v12-compat/scanner.ts` mit Ruleset-Source `vscode-tm1-ti@cf73b93 / tiSignatures.ts (synced 2026-05-12)`
  - Strukturierte Findings (severity/category/objectKind/section/line/function/issue/suggestion) — nicht aus `audit_naming` + `audit_complexity` rekonstruierbar
  - Read-only 2 REST-Calls (Processes + Cubes/Rules), token-effizient bei >50 Processes
  - Skill-Compose würde Ruleset-Pflege auf Client-Seite verlagern, schlechter

Audit-Backlog abgeschlossen 2026-05-27.
