# TM1 MCP Tool Audit — Konsolidierungs-Vorschläge

Stand: 2026-05-26. Diskussions-Entwurf — nicht alle Punkte sind beschlossen.

**Scope ursprünglich:** 105 Tools über 13 Kategorien.
**Aktueller Stand:** 102 Tools über 12 Kategorien (nach Drops vom 2026-05-26).
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
| `tm1_resolve_default_member` (1x) + `_members` (1–64) | Singular droppen — Plural akzeptiert N=1 |
| ~~`tm1_list_processes` + `_grouped`~~ | ~~Merge via `groupBy?` Param~~ — **verworfen**, beide behalten (siehe §7) |
| TI-Einzel-Tools vs. `upsert_process` (5 Tools: `create_process`, `update_process_code/parameters/variables/datasource`) | **Linie B umgesetzt** — alle 5 ersatzlos durch `upsert_process` abgedeckt (✅ 2026-05-26, siehe §7) |
| `tm1_get_cube_rules` vs `get_all_cube_rules` | beide behalten (Single-Object vs Map-Return verschieden) |
| `tm1_check_process_code` vs `compile_process` | beide behalten (lokal vs server-side, Beschreibung schärfen) |

Netto: 5 Tools weg (Linie B). Resolve-Singular noch offen.

---

## 2) 🔵 SKILL-Kandidaten — kein TM1-Roundtrip nötig

| Tool | Begründung | Migration |
|---|---|---|
| `tm1_check_v12_readiness` | Compound aus naming + complexity + pattern-grep | Skill `tm1-v12-migration` orchestriert existierende Audits, Tool droppen |
| `tm1_diagnose_process_error` | Workflow: list_logs → get_content → siblings | Hybrid: Tool für Latenz behalten + MCP-Prompt zusätzlich registrieren |
| `.pro`-Lifecycle (`import_pro_file` / `export_process_to_pro` / `install_pro_bundle` / `diff_process_with_file`) | Atomare Bausteine, aber 3-stufiger Standardworkflow | Tools behalten, Workflow-Skill `tm1-deploy-pro` als Composer |

---

## 3) 🔴 DROP — komplett raus

- `tm1_resolve_default_member` (durch Plural) — **noch offen**
- ~~`tm1_list_processes_grouped`~~ — **verworfen**, beide behalten (siehe §7)
- ~~`tm1_get_process_variables` / `_parameters`~~ — **erweitert zu Linie B (siehe nächster Punkt)**
- **Linie B (5 Tools):** `tm1_create_process`, `tm1_update_process_code`, `tm1_update_process_parameters`, `tm1_update_process_variables`, `tm1_update_process_datasource` — **ersatzlos**, alle abgedeckt durch `tm1_upsert_process` (✅ umgesetzt 2026-05-26)
- `tm1_check_v12_readiness` (→ Skill `tm1-v12-migration`) — **noch offen**, blockiert auf Skill-Build
- `tm1_get_knowledge` — **ersatzlos**, Skill `tm1-knowledge` deckt ab (✅ umgesetzt 2026-05-26, commit `be5cbe7`)

Netto bisher: 6 Tools weniger → 102. Noch offen: `resolve_default_member` (Singular) + `check_v12_readiness` (skill-pending).
Plus 2 neue Skills geplant (`tm1-v12-migration`, `tm1-deploy-pro`).

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
   - `tm1_resolve_default_member` (Singular) — noch offen
2. **Phase 2:** `tm1-v12-migration` Skill bauen → `check_v12_readiness` Tool droppen
3. **Phase 3:** `tm1-deploy-pro` Skill als Workflow-Composer für `.pro`-Lifecycle

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

Noch offen:
- [ ] `tm1_resolve_default_member` (Singular) — Plural deckt N=1 funktional, kostet aber Array-Wrap. Entscheidung pending.
- [ ] `tm1_check_v12_readiness` — blockiert auf `tm1-v12-migration` Skill-Build (Phase 2)
