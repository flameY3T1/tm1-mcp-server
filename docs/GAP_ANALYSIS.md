# Gap-Analyse: TM1-Berater/Entwickler-Perspektive

**Stand:** 2026-06-06 (abends — P1 komplett, Tracing aus P2 shipped; Tool-Count 105)
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
| ~~`confirm`-Param auf destruktiven Tools~~ | — | **War nie ein Gap**: existiert seit R2-10 (`src/tools/confirm.ts`, `requireConfirm` auf delete_cube/_dimension/_process, clear_cube). Ursprüngliche Meldung war Grep-Fehler. |
| ~~Config-Read~~ | — | **War nie ein Gap**: `tm1_get_server_info` merged `/Configuration` + `/ActiveConfiguration`, voller Tree unter `_raw`. |

Lessons aus der Umsetzung (für künftige Tools):
- 11.8 lehnt `($levels=...)` auf Complex-Collections ab → Expand-Pfadform (`Components/Tuple`), ein Pfad-Segment pro Ebene.
- `tm1.CheckFeeders` liefert nur Problem-Zellen — leeres Ergebnis = Feeder gesund.
- Node 26 built-in fetch droppt `Set-Cookie` bei npm-undici-Dispatcher → `tm1Fetch` in `dispatcher.ts` (Fix `b4f69a4`, betraf alle Tools).

---

## 1. Offene Tool-Gaps (Code-geprüft, nicht vorhanden)

### P2 — hoher Impact, mittlerer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **Sandbox-Tools** (`list/create/publish/discard`) | `/Sandboxes`, `tm1.Publish`, `tm1.DiscardChanges` | M | Planner-Workflows komplett unabgedeckt. What-if-Analysen, sicheres Testen von Writes ohne Basis-Daten zu berühren. Nur Erwähnung in `v12-compat/deprecated-ti.ts`, keine Tools. **Nächster Kandidat.** |
| **`tm1_get_audit_log`** | `/AuditLogEntries` | S | Compliance/Forensik: wer hat wann Metadaten/Security geändert. Message-/Transaction-/Error-Log vorhanden, AuditLog fehlt. |
| **`tm1_create_native_view`** | `/Cubes('x')/Views` (NativeView) | S | Nur MDX-Views erstellbar (`tm1_create_mdx_view`). Native Views mit Subsets sind Standard als TI-Datasource und für Zeros-Suppression-Exporte. Lesen geht (`get_view_definition`), Schreiben fehlt. |

### P3 — strategisch, größerer Aufwand

| Gap | REST-API | Aufwand | Begründung |
|---|---|---|---|
| **Multi-Instanz-Support** | — (Architektur) | L | `src/config.ts`: genau eine `TM1_BASE_URL`. Berater arbeiten immer mit DEV/QA/PROD (real beobachtet: Test-Instanzen auf 12331 + 12322 parallel). Benötigt: benannte Instanzen, `instance`-Param (optional, default wie heute), Connection-Registry im Client-Layer. Türöffner für Cross-Env-Diff & Promotion (größter ungelöster Berater-Schmerzpunkt überhaupt). Eigenes Design-Doc vorab (`docs/plans/`). |
| **Git-API-Tools** (v11.8+) | `!git` Endpoints (`GitInit`, `GitPush`, `GitPull`, Deploy — in $metadata des Test-Servers bestätigt) | M | Modell-Versionierung/Deployment nativ. `requiresVersion: v11`-Annotation nötig. Nur sinnvoll nach Multi-Instanz oder für Single-Env-Versionierung. |
| **Cell-Annotations** | `/Annotations` | S | Kommentare an Zellen — Planungsprozesse nutzen das, Berater selten. Niedrigste Prio in dieser Gruppe. |
| **Config-Write** | `PATCH /StaticConfiguration` | S | Tuning-Params setzen + `/StaticConfiguration`-Read (pending Restart-Werte). Destruktiv-nah, nur mit Confirm-Mechanik. |

---

## 2. Architektur-Optimierungen

| # | Thema | Status / Vorschlag |
|---|---|---|
| A1 | **Multi-Instanz** (s.o. P3) | Größter struktureller Hebel. Service-Composition-Pattern bleibt — Registry liefert pro Instanz einen Service-Satz. |
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

1. **Sandbox-Tools** — M, neue Nutzergruppe (Planner).
2. **`tm1_get_audit_log` + `tm1_create_native_view`** — je S, rundet Lücken ab.
3. **Multi-Instanz** — L, eigenes Design-Dokument vorab (`docs/plans/`).

Nicht angefasst: Git-API, Annotations, Config-Write, Subscriptions, A2–A5 — erst bei konkretem Bedarf.
