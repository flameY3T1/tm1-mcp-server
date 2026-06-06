# Gap-Analyse: TM1-Berater/Entwickler-Perspektive

**Stand:** 2026-06-06
**Basis:** Tool-Surface-Audit (101 Tools, 12 Kategorien) + Code-Verifikation per Grep gegen `src/`.
**Frage:** Was fehlt einem TM1-Berater/-Entwickler im Alltag noch — Tools, Architektur, Workflows?

Bereits geprüfte und **abgelehnte** Vorschläge werden hier nicht erneut aufgeführt
(Singular-Drops, View-Merges, Bedrock-Detection→Skill, Output-Coord-Drift→Skill;
siehe `TOOL_AUDIT.md` §7).

---

## 1. Verifizierte Tool-Gaps (Code-geprüft, nicht vorhanden)

### P1 — hoher Berater-Impact, geringer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **`tm1_save_data`** (SaveDataAll, optional pro Cube) | `tm1.SaveData` / Cube-Action | XS | Tägliche Admin-Operation. Nach jeder Write-Session Pflicht, sonst Datenverlust-Risiko bei Server-Crash. Einziger Weg aktuell: TI-Prozess schreiben. |
| **`confirm`-Param auf destruktiven Tools** | — | S | `delete_cube`, `delete_dimension`, `delete_process`, `clear_cube` löschen ohne Rückfrage (R2-10, im Code nicht vorhanden — Grep leer). Alternativ: MCP-Elicitation statt Param. |

### P2 — hoher Impact, mittlerer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **Sandbox-Tools** (`list/create/publish/discard`) | `/Sandboxes`, `tm1.Publish`, `tm1.DiscardChanges` | M | Planner-Workflows komplett unabgedeckt. What-if-Analysen, sicheres Testen von Writes ohne Basis-Daten zu berühren. Nur Erwähnung in `v12-compat/deprecated-ti.ts`, keine Tools. |
| **Feeder-/Cell-Tracing** (`tm1_trace_cell`, `tm1_check_feeders`) | `tm1.TraceCellCalculation`, `tm1.TraceFeeders`, `tm1.CheckFeeders` | M | Rule-Debugging Nr.-1-Schmerzpunkt. `tm1_audit_feeders` (statisch) existiert, aber kein Per-Cell-Trace: "warum ist diese Zelle leer/falsch?" Perfekte Ergänzung zum bestehenden Audit. |
| **`tm1_get_audit_log`** | `/AuditLogEntries` | S | Compliance/Forensik: wer hat wann Metadaten/Security geändert. Message-/Transaction-/Error-Log vorhanden, AuditLog fehlt (Grep: nur Erwähnung in server-info). |
| **`tm1_create_native_view`** | `/Cubes('x')/Views` (NativeView) | S | Nur MDX-Views erstellbar (`tm1_create_mdx_view`). Native Views mit Subsets sind Standard als TI-Datasource und für Zeros-Suppression-Exporte. Lesen geht (`get_view_definition`), Schreiben fehlt. |

### P3 — strategisch, größerer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **Multi-Instanz-Support** | — (Architektur) | L | `src/config.ts`: genau eine `TM1_BASE_URL`. Berater arbeiten immer mit DEV/QA/PROD. Benötigt: benannte Instanzen, `instance`-Param (optional, default wie heute), Connection-Registry im Client-Layer. Türöffner für Cross-Env-Diff & Promotion (größter ungelöster Berater-Schmerzpunkt überhaupt). |
| **Git-API-Tools** (v11.8+) | `!git` Endpoints (`GitInit`, `GitPush`, `GitPull`, Deploy) | M | Modell-Versionierung/Deployment nativ. `requiresVersion: v11`-Annotation nötig. Nur sinnvoll nach Multi-Instanz oder für Single-Env-Versionierung. |
| **Cell-Annotations** | `/Annotations` | S | Kommentare an Zellen — Planungsprozesse nutzen das, Berater selten. Niedrigste Prio in dieser Gruppe. |
| **Config-Write** | `PATCH /StaticConfiguration` | S | Config-**Read** ist abgedeckt: `tm1_get_server_info` merged `/Configuration` + `/ActiveConfiguration`, voller Tree unter `_raw`. Fehlt nur: Schreiben (Tuning-Params setzen) + `/StaticConfiguration`-Read (pending Restart-Werte). Destruktiv-nah, nur mit Confirm-Mechanik. |

---

## 2. Architektur-Optimierungen

| # | Thema | Status / Vorschlag |
|---|---|---|
| A1 | **Multi-Instanz** (s.o. P3) | Größter struktureller Hebel. Service-Composition-Pattern bleibt — Registry liefert pro Instanz einen Service-Satz. |
| A2 | **MCP-Elicitation für destruktive Ops** | Moderner als `confirm`-Param: Server fordert Bestätigung über Protokoll an. Löst R2-10 eleganter; Fallback `confirm`-Param für Clients ohne Elicitation-Support. |
| A3 | **Progress-Notifications** (R2-02, offen) | 5 Long-Running-Tools (`import_pro_file`, `analyze_callgraph`, `search_code`, `install_pro_bundle`, `diff_process_with_file`). UX, prio mittel. |
| A4 | **Resource-Subscriptions** (R2-05, offen) | server-state/threads/sessions ohne Polling. Prio niedrig, erst bei realem HTTP-Multi-Client-Einsatz. |
| A5 | **Auto-Invalidate Callgraph nach Schema-Mutationen** (R2-22, offen) | `upsert_process`/`delete_process` → Cache-Invalidierung automatisch statt manuell. S-Aufwand, klarer Korrektheitsgewinn. |

Won't-fix bleibt: HTTP-Auth/Token-Binding (R2-08/09) — stdio-Default, kein Remote-Use-Case.

---

## 3. Skill-/Wissens-Gaps (out-of-repo, bestehender Backlog)

Aus `improvements_consolidated` offen geblieben — kein MCP-Server-Code:

- **`tm1-monitor`-Skill**: Thread-Monitoring, Error-Log-Triage, Transaction-Audit als geführter Workflow (Tools existieren alle).
- **Knowledge-Files**: `tm1-v12-migration.md`, `tm1-dataflow-template.md`, `tm1-audit-template.md`.
- **Steering 4.5–4.10**: selektive Folge-Analysen, Credential-Warnungen, sparsames Prozess-Listing u.a.

Empfehlung: zusammen mit Feeder-Tracing (P2) ein `tm1-rule-debug`-Skill — Trace-Tools + bestehender `tm1_audit_feeders` + `review-ti` ergäben kompletten Debugging-Workflow.

---

## 4. Empfohlene Reihenfolge

1. **`tm1_save_data`** — XS, sofortiger Alltagsnutzen.
2. **Destruktive Ops absichern** (Elicitation + `confirm`-Fallback) — S, Sicherheitsgewinn.
3. **Sandbox-Tools** — M, neue Nutzergruppe (Planner).
4. **Feeder-/Cell-Tracing** — M, stärkt vorhandene Audit-Stärke.
5. **`tm1_get_audit_log` + `tm1_create_native_view`** — je S, rundet Lücken ab.
6. **Multi-Instanz** — L, eigenes Design-Dokument vorab (`docs/plans/`).

Nicht angefasst: Git-API, Annotations, Config-Write, Subscriptions — erst bei konkretem Bedarf.
