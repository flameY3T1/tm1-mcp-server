# TM1 MCP Tool Audit — Konsolidierungs-Vorschläge

Stand: 2026-05-26. Diskussions-Entwurf — nicht alle Punkte sind beschlossen.

**Scope:** 105 Tools über 13 Kategorien. Server hat zusätzlich MCP **Prompts**
(`tm1_orientation`) + MCP **Resources** (`tm1://...` URIs) als alternative
Endpoints für read-only Daten und Workflow-Templates.

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
| `tm1_list_processes` + `_grouped` | `groupBy?` Param auf `list_processes`, `_grouped` droppen |
| `tm1_get_process_variables` / `update_process_variables` | droppen — selten ohne Code-Update gebraucht; `upsert_process` deckt Bundle |
| `tm1_get_process_parameters` / `update_process_parameters` | droppen — gleicher Grund |
| `tm1_get_cube_rules` vs `get_all_cube_rules` | beide behalten (Single-Object vs Map-Return verschieden) |
| `tm1_check_process_code` vs `compile_process` | beide behalten (lokal vs server-side, Beschreibung schärfen) |

Netto: 6 Tools weg ohne Funktionsverlust.

---

## 2) 🔵 SKILL-Kandidaten — kein TM1-Roundtrip nötig

| Tool | Begründung | Migration |
|---|---|---|
| `tm1_check_v12_readiness` | Compound aus naming + complexity + pattern-grep | Skill `tm1-v12-migration` orchestriert existierende Audits, Tool droppen |
| `tm1_diagnose_process_error` | Workflow: list_logs → get_content → siblings | Hybrid: Tool für Latenz behalten + MCP-Prompt zusätzlich registrieren |
| `.pro`-Lifecycle (`import_pro_file` / `export_process_to_pro` / `install_pro_bundle` / `diff_process_with_file`) | Atomare Bausteine, aber 3-stufiger Standardworkflow | Tools behalten, Workflow-Skill `tm1-deploy-pro` als Composer |

---

## 3) 🔴 DROP — komplett raus

- `tm1_resolve_default_member` (durch Plural)
- `tm1_list_processes_grouped` (in `list_processes` als Param)
- `tm1_get_process_variables` / `_parameters` (4 Tools — selten atomar)
- `tm1_check_v12_readiness` (→ Skill `tm1-v12-migration`)
- `tm1_get_knowledge` — **ersatzlos**, Skill `tm1-knowledge` deckt bereits ab, basiert auf gleichem Inhalt

Netto: ~8 Tools weniger → 97. Plus 2 neue Skills (`tm1-v12-migration`, `tm1-deploy-pro`).

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

1. **Phase 1 (klein, sofort):** Singular `resolve_default_member`, `list_processes_grouped`, 4× variables/parameters, `tm1_get_knowledge` → 7 Tools weg
2. **Phase 2:** `tm1-v12-migration` Skill bauen → `check_v12_readiness` Tool droppen
3. **Phase 3:** `tm1-deploy-pro` Skill als Workflow-Composer für `.pro`-Lifecycle

---

## 6) Lifecycle-Tags (Doku-Empfehlung)

Frequenz in tool descriptions:
- **HOT** (täglich): `list_*`, `execute_mdx`, `write_cells`, `get/update_process_code`, `execute_process`, `audit_*`
- **WARM** (wöchentlich): `create_*`, `upsert_process`, `validate_process_refs`, `diagnose_*`
- **COLD** (admin/selten): `clear_cube`, `unload_cube`, `invalidate_callgraph_cache`, `cancel_thread`, `list_sessions`

LLM priorisiert besser wenn Frequenz explizit.

---

## 7) Offene Punkte / TODO

Entscheidungen aus User-Review:

- [x] `tm1_get_knowledge` → **ersatzlos droppen** (Skill `tm1-knowledge` existiert bereits, basiert auf gleichem Inhalt; kein Fallback für Nicht-Claude-Clients nötig)

Noch offen:
- [ ] _ggf. weitere Punkte_
