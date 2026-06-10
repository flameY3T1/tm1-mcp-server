# tm1-mcp-server — Roadmap

> Stand: 2026-05-08. Konsolidierte Fassung der Backlog-Quellen
> (`improvements_consolidated.md`, `improvements_consolidated2.md`,
> `improvements_mcp.md`, `improvements_mcp2.md`).
> ~85% der ursprünglichen Items sind erledigt; diese Datei führt nur den
> aktuellen Stand. Persistente Status-Notizen für Claude liegen im lokalen
> Claude-Projekt-Memory (`~/.claude/projects/<project>/memory/`).

## Architektur-Backlog (Source: MCP-Builder-Review 2026-05-07)

### Tier 2 — Mittlerer Hebel

- **#5 `tm1-client.ts` god-class split** (2334 LOC, 85 async-Methoden).
  Domain-Split nach Kategorien (cubes/dimensions/processes/cells/views/
  security/operations). Mixin-Komposition oder Facade. Nur angehen wenn
  Merge-Konflikte beim parallelen Editieren auftauchen. Public-API
  stable halten (98 Tools importieren `tm1-client` direkt).
- **#6 `evals/tm1-mcp-evals.xml`** mit `TODO:` Antworten. Gegen
  Test-Instanz solven und freezen, oder als WIP markieren.

### Tier 3 — Hygiene

- **#13 Streamable-HTTP-Transport optional** (`--transport http|stdio`).
  Defer until remote use-case auftaucht.
- **#14 Per-tool timeout override** (statt globalem `requestTimeoutMs`
  30s). Verbunden mit `tm1_check_process_running`-Diskussion. Defer.
- **#15 `process-execution/`-dir Inkonsistenz**: nur 2 Files,
  `update-process-parameters/variables/datasource` sitzen in
  `ti-development/`. Move oder README-Note.
- **#16 tsconfig strict-flags**: `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
  Pilot-Run 2026-05-08: `noUncheckedIndexedAccess` allein produziert 110
  Fehler über 15 Files (Hotspots: tiParser 23, pro-parser 18,
  referenceIndex 17, sample-cells 10, rulesLinter 8). Größtenteils
  mechanisch (`arr[i] ?? fallback`, optional-chain, `if (!entry) continue`).
  Nicht in dieser Combo angefasst — eigene PR mit fokussiertem Diff.

### Erledigt (Architektur)

- #1 TLS-Bypass scoped to TM1 fetches (undici dispatcher)
- #2 Dead try/catch entfernt (codemod, 54 files)
- #3 outputSchema-Coverage 73 → 97
- #4 annotation-map gaps + CI-throw
- #7 execute-mdx Page-envelope
- #8 SessionManager DRY (`withTimeout` helper)
- #9 Version-Bump 0.1.0 → 1.0.0
- #10 README tool-matrix auto-gen
- #11 Backlog-MDs konsolidiert → diese Datei
- #12 Zone.Identifier git-leak entfernt
- #17 `asOutputSchema()` helper (passthrough/catchall-Detection via `_def.catchall`)
- #18 Coverage-Enforcement CI (Baseline-Thresholds 21/17/20/22, ratchet zu 50% mid-term)

## Feature-Backlog

### Quick Win

- **`tm1_check_cube_rule` TI-only-Hints** (mcp #6 / mcp2 #4).
  Pattern-Match auf TI-only-Funktionen (YEAR/MONTH/DAY/NumberToString)
  in Rules-Code → Hint mit Alternative (z.B. `TIMST(NOW, '\\Y')`).
  ~30 min, `src/tools/model-building/check-cube-rule.ts`.

### Mittlerer Hebel

- **`tm1_get_system_overview`** (mcp2 #1) — All-in-One Audit-Snapshot
  (server-state + cubes + dims + processes + chores in einem Call).
- **`tm1_find_orphaned_objects`** (mcp2 #3) — Top-Pick. Scope-Diskussion
  2026-05-07: "broken refs in Processes/Chores/Rules" eindeutig
  (Process-DataSource auf nicht-existenten Cube/View, Chore-Steps auf
  gelöschte Processes, Rule-DB() auf gelöschte Cubes); "ungenutzt"
  subjektiv und excluded.
- **`tm1_get_element_security` / `tm1_set_element_security`**
  (mcp2 #5 / mcp #8) — `}ElementSecurity_*` Cube. Lese/schreibe pro
  Gruppe (NONE/READ/WRITE/RESERVE/LOCK), `namePattern`-Filter für Bulk.
- **`tm1_save_data`** (v2 1.6) — Explizites SaveDataAll ohne TI-Prozess.
- **`tm1_list_sandboxes` / `tm1_get_sandbox`** (v2 1.7) — Sandbox-Mgmt.
- **`tm1_rename_dimension` / `tm1_rename_cube`** (v2 1.8) — Refactoring
  ohne Rebuild.
- **`tm1_execute_ti_code`** (v2 1.10) — Ad-hoc TI-Code unbound (ohne
  Prozess-Anlage).
- **`tm1_get_cube_rules_summary`** (alt 2.1) — Aggregate-Metriken
  (lineCount, ruleCount, feederCount, referencedCubes). Teilweise via
  `tm1_get_all_cube_rules(summary=true)` abgedeckt, eigenständiges Tool
  optional.

### Hoher Aufwand

- **`tm1_sample_feeder_hit_rate`** (mcp2 #2) — MDX-Stichprobe,
  Trefferquote der Feeder.
- **`tm1_copy_cube`** (mcp2 #8) — Clone Dims+Rules+Daten+Views,
  Self-Ref-Rewrite.

### v12-Support (defer)

- **v12 CAM-Auth + async REST** (v2 3.3) — Niedrig. Wartet auf
  konkreten Bedarf.

## Steering / Knowledge / Skills (Out-of-Repo)

Diese Items leben unter `~/.claude/.../skills/` bzw. den
`.kiro/steering/`-Pfaden des konsumierenden Workspaces, nicht im
MCP-Server-Repo. Hier nur als Referenz aufgeführt:

- **Steering 4.5–4.10** — Folge-Analysen selektiv, Hierarchie-Analyse
  direkt, Credential-Warnung bei `ExecuteCommand`/`ODBC`-Suche,
  Fallback bei `update_process_code`-Fehler, Prozesse sparsam listen,
  Workspace-unter-Git-Warnung.
- **Knowledge 5.1–5.3** — `tm1-v12-migration.md`, `tm1-dataflow-template.md`,
  `tm1-audit-template.md` als Inhaltsdateien für `tm1_get_knowledge`.
- **Skills 6.1–6.6** — Skill-Aktivierung, Pfad-Single-Source, neuer
  Skill `tm1-monitor` (Thread-Monitoring, Error-Log, Transaction-Audit).

## Erledigte Items (Feature-Seite, Auswahl)

### Listing-Optimierung
- `includeControl` (list-cubes/dimensions/processes)
- `fields`/`compact` (list-cubes, list-chores)
- `list_clients` projection + groupCount
- `get_hierarchy` compact + `nameContains/nameStartsWith/nameRegex`
- `fetchAll: true` Flag in `pagination.ts`, `limit:0` als Alias
- `list_groups` compact + clientCount
- `list_sessions` compact
- `analyze_callgraph` compact
- `excludePattern` für `list_processes`

### Neue Tools
- `tm1_diagnose_process_error`
- `tm1_list_processes_grouped`
- `tm1_get_cube_stats`
- `tm1_get_knowledge` (`TM1_KNOWLEDGE_DIR`)
- `tm1_get_descendants` / `tm1_get_ancestors`
- `tm1_sample_cells` (NON EMPTY CROSSJOIN, HEAD-Limit, per-Dim-Filter)
- `tm1_get_view_definition` (MDX/NativeView ohne Execute)

### Bugs / Sicherheit
- Credential-Maskierung callgraph + chore_graph (`mask-secrets.ts`)
- `search_code` excludeCommented + maskSecrets
- `get_error_log_content` `includeRelated` + Schema-Fix (typed `related`)
- `update_process_code` Logging + receivedTabs + tabBytes hints
- Output-Schema Process-Update-Tools (MutationResultSchema)
- Startup-Cred-Validation (leerer Pass legitim, baseUrl/user throw)
- autoApprove Allowlist (destruktive Tools entfernt)
- Unit/Property-Tests (`tests/unit`, `tests/property`)
- `upsert_process` autoCompile Option

### Gestrichen
- `tm1_get_cube_dimensions_overview` — abgedeckt durch
  `list_cubes(nameExact:X, includeDimensions:true)`.
- `list_sessions` ID-Typ — false alarm; `getSessions()` macht
  `String(s.ID)`.
- `tm1_get_element_parents/_children` — abgedeckt durch
  `get_ancestors`/`get_descendants`.

## Top-Picks (offen, Stand 2026-05-08)

1. `check_cube_rule` TI-only-Hints — Quick Win
2. `find_orphaned_objects` — Audit-Mehrwert (Top-Pick)
3. `get_system_overview` — Audit-Snapshot
4. ElementSecurity get/set
5. `copy_cube` (Aufwand hoch)
