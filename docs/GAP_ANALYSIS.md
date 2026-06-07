# Gap-Analyse: TM1-Berater/Entwickler-Perspektive

**Stand:** 2026-06-07 (audit_log + native_view shipped; Sandbox + Multi-Instanz won't-do; Tool-Count 107 — **alle Tool-Gaps geschlossen**)
**Basis:** Tool-Surface-Audit (101 Tools, 12 Kategorien) + Code-Verifikation per Grep gegen `src/` + Live-Validierung gegen 11.8.
**Frage:** Was fehlt einem TM1-Berater/-Entwickler im Alltag noch — Tools, Architektur, Workflows?

Bereits geprüfte und **abgelehnte** Vorschläge werden hier nicht erneut aufgeführt
(Singular-Drops, View-Merges, Bedrock-Detection→Skill, Output-Coord-Drift→Skill;
siehe `TOOL_AUDIT.md` §7).

---

## 0. Umgesetzt (aus dieser Analyse)

| Item | Commit | Notizen |
|---|---|---|
| `tm1_save_data` (SaveDataAll/CubeSaveData) | `e4b0429` | Keine native SaveData-OData-Action ($metadata verifiziert) — unbound TI via `ExecuteProcessWithReturn` (11.3+). v11-only, IDEMPOTENT_WRITE. E2E + live validiert. |
| Feeder-/Cell-Tracing: `tm1_check_feeders`, `tm1_trace_feeders`, `tm1_trace_cell_calculation` | `a174ffc`, `7c08acd` | Cube-gebundene Actions mit `Tuple@odata.bind`. Tree-Truncation client-seitig (maxDepth/maxComponents, `truncated`-Flag). Cross-Cube-Drilldown mit `cube`+`tuple` auf jeder Ebene. Live gegen befülltes Modell validiert (Rule→DB→Konsolidierung über 3 Cubes). v11-only. |
| Standard-Alignment der 4 neuen Tools | `0f15aeb` | `timeoutMs`, EXAMPLES §9.4–9.6, `tm1_rules_review`-Prompt Schritt 5. |
| `tm1_get_audit_log` | 2026-06-07 | `/AuditLogEntries` mit Filtern (user/objectType/objectName/since/until) + optional `$expand=AuditDetails`. v11-only, READ_ONLY. Braucht `AuditLogOn=T` — Tool-Doc verweist auf `auditLogEnabled` in `tm1_get_server_info`. Live validiert. |
| `tm1_create_native_view` | 2026-06-07 | NativeView-POST mit drei Subset-Quellen pro Achse (registriert / MDX-Expression / Element-Liste als anonyme Subsets). Titles erfordern `selected` (TM1-400 sonst — Validierung client-seitig). Dabei pre-existing Bug in `tm1_get_view_definition` gefixt: 11.8 lehnt `Titles($expand=…)` auf Complex-Collections ab → Pfad-durch-Complex + Parens ab Entity (`Titles/Subset($expand=…)`). Live validiert (Create→Definition→Delete, Umlaute OK). |
| ~~`confirm`-Param auf destruktiven Tools~~ | — | **War nie ein Gap**: existiert seit R2-10 (`src/tools/confirm.ts`, `requireConfirm` auf delete_cube/_dimension/_process, clear_cube). Ursprüngliche Meldung war Grep-Fehler. |
| ~~Config-Read~~ | — | **War nie ein Gap**: `tm1_get_server_info` merged `/Configuration` + `/ActiveConfiguration`, voller Tree unter `_raw`. |

Lessons aus der Umsetzung (für künftige Tools):
- 11.8 lehnt `($levels=...)` auf Complex-Collections ab → Expand-Pfadform (`Components/Tuple`), ein Pfad-Segment pro Ebene.
- `tm1.CheckFeeders` liefert nur Problem-Zellen — leeres Ergebnis = Feeder gesund.
- Node 26 built-in fetch droppt `Set-Cookie` bei npm-undici-Dispatcher → `tm1Fetch` in `dispatcher.ts` (Fix `b4f69a4`, betraf alle Tools).

---

## 1. Offene Tool-Gaps (Code-geprüft, nicht vorhanden)

### P2 — hoher Impact, mittlerer Aufwand

*Leer — alle P2-Gaps am 2026-06-07 geschlossen (s. §0).*

### P3 — strategisch, größerer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **Git-API-Tools** (v11.8+) | `!git` Endpoints (`GitInit`, `GitPush`, `GitPull`, Deploy — in $metadata des Test-Servers bestätigt) | M | Modell-Versionierung/Deployment nativ. `requiresVersion: v11`-Annotation nötig. Use-Case: Single-Env-Versionierung (Multi-Instanz ist won't-do). |
| **Cell-Annotations** | `/Annotations` | S | Kommentare an Zellen — Planungsprozesse nutzen das, Berater selten. Niedrigste Prio in dieser Gruppe. |
| **Config-Write** | `PATCH /StaticConfiguration` | S | Tuning-Params setzen + `/StaticConfiguration`-Read (pending Restart-Werte). Destruktiv-nah, nur mit Confirm-Mechanik. |

---

## 2. Architektur-Optimierungen

| # | Thema | Status / Vorschlag |
|---|---|---|
| A1 | **Multi-Instanz** | **Won't-do (2026-06-07).** Instanzwahl läuft über MCP-Client-Config: mehrere Server-Einträge (`tm1-dev`, `tm1-prod`) mit je eigener `TM1_BASE_URL` — null Code, explizite Wahl pro Session. Damit entfallen auch Cross-Env-Diff/Promotion als Server-Feature; falls Bedarf, Skill-/Workflow-Ebene. |
| A2 | **MCP-Elicitation für destruktive Ops** | `confirm`-Param existiert bereits (R2-10 umgesetzt). Elicitation wäre optionales Upgrade: Bestätigung über Protokoll statt Param-Wiederholung. Prio niedrig. |
| A3 | **Progress-Notifications** (R2-02, offen) | 5 Long-Running-Tools (`import_pro_file`, `analyze_callgraph`, `search_code`, `install_pro_bundle`, `diff_process_with_file`). UX, prio mittel. |
| A4 | **Resource-Subscriptions** (R2-05, offen) | server-state/threads/sessions ohne Polling. Prio niedrig, erst bei realem HTTP-Multi-Client-Einsatz. |
| A5 | **Auto-Invalidate Callgraph nach Schema-Mutationen** (R2-22, offen) | `upsert_process`/`delete_process` → Cache-Invalidierung automatisch statt manuell. S-Aufwand, klarer Korrektheitsgewinn. |

Won't-fix bleibt: HTTP-Auth/Token-Binding (R2-08/09) — stdio-Default, kein Remote-Use-Case.

---

## 3. Skill-/Wissens-Gaps (out-of-repo, bestehender Backlog)

Aus `improvements_consolidated` offen geblieben — kein MCP-Server-Code:

- **`tm1-rule-debug`-Skill**: jetzt voll möglich — die geshippten Trace-Tools + `tm1_audit_feeders` + `review-ti` ergeben kompletten Debugging-Workflow (statisch finden → per Zelle verifizieren). Erste Stufe bereits im `tm1_rules_review`-Prompt (Schritt 5).
- **`tm1-monitor`-Skill**: Thread-Monitoring, Error-Log-Triage, Transaction-Audit als geführter Workflow (Tools existieren alle).
- **Knowledge-Files**: `tm1-v12-migration.md`, `tm1-dataflow-template.md`, `tm1-audit-template.md`.
- **Steering 4.5–4.10**: selektive Folge-Analysen, Credential-Warnungen, sparsames Prozess-Listing u.a.

---

## 4. Empfohlene Reihenfolge (offen)

*Keine offenen Tool-Gaps mehr.* Verbleibend nur Skill-/Wissens-Backlog (§3).

Won't-do (2026-06-07): **Multi-Instanz** (Instanzwahl via MCP-Client-Config, s. A1) und **Sandbox-Tools** (Planner-Workflows kein Use-Case dieses Servers).

Nicht angefasst: Git-API, Annotations, Config-Write, Subscriptions, A2–A5 — erst bei konkretem Bedarf.
