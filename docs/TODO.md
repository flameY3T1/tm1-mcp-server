# TM1 MCP Server — Backlog

Source: `~/.claude/projects/-home-user-tm1-ai-dev/memory/` (project_mcp_tool_gaps.md, project_lifecycle_gaps.md, reference_mcp_callgraph_tools.md). Captured 2026-05-01.

## High-Impact Tools (Token-burn / Workflow-Reibung)

- [x] **`tm1_import_pro_file`** — Parse `.pro` (Tabs/Params/DataSource) + 1-Call deploy. Heute: 4 Tabs als Inline-String (1600+ Zeilen) via `tm1_update_process_code` + separate `tm1_update_process_parameters`. _Done 2026-05-01 (commit 21ddee1)._
- [ ] **`tm1_diff_process_with_file`** — Installed vs `.pro` Datei: Param-Diff + Code-Diff. Heute manuell via Read+Vergleich.
- [x] **`tm1_search_code`** — Regex über alle TI-Code (Wrapper auf `tm1_get_all_processes_code` + lokaler Grep). Heute: bulk-load + Bash-grep. _Done 2026-05-01 (commit 21ddee1)._
- [x] **`tm1_callgraph_summary`** — `mode: "summary"` für `tm1_analyze_callgraph` (Caller-Counts + flache Liste statt full Tree). Vermeidet 1.8 MB OOM-Output bei großen Trees. _Done 2026-05-01 (commit 21ddee1, integrated into tm1_analyze_callgraph)._
- [ ] **`tm1_install_pro_bundle`** — Verzeichnis `.pro`-Files → bulk install. Für Rest-Bedrock-Install ohne Hand-Push.
- [ ] **`tm1_upsert_process`** — Atomar Code+Params+Datasource in 1 Call (heute 2-3 Calls, nicht atomar).
- [ ] **Bedrock-Version-Detection** — `Ver 4.0` Marker im Prolog-Tail als Process-Property exposen.

## Quality-Gates pre-execute (verhindert Runtime-Crashes)

- [ ] **Pre-Write Rule-Check** — vor jedem `CellPutN` prüfen ob Ziel-Coord (Cube + Element + Slice) bereits Rule-berechnet ist. Bei Konflikt Architektur-Frage erzwingen (Rules behalten / TI ablöst Rules / Acceptance).
- [ ] **Dim-Name-Verifikation** — TI-Prolog-Subset/View-Targets gegen aktuelle Cube-Dim-Liste abgleichen vor Compile. TM1 erlaubt syntaktisch validen Code mit nicht-existierenden Dims; Fehler erst zur Runtime.
- [ ] **N-Level vs Consolidated Element-Check** — vor `CellPutN` prüfen ob Ziel-Element N-Level ist. Konsolidierungs-Coord → silent fail oder Error.
- [ ] **Output-Coord-Drift-Detektion** — TI per (Linie, Baureihe) loop vs Rules RHS auf (`ohne_*`, `ohne_*`) → Storage-Explosion oder Lookup-Fehlschlag.

## Skill / Workflow-Lücken (vorgelagert, kein MCP-Tool)

- Acceptance-Gate ungated (acceptance.md nur Checkliste, nicht maschinell verifiziert).
- Bedrock-Fallback fehlt bei `bedrock_installed: false`.
- Übergang Review→Debug manuell (Copy/Paste Prozessname).
- Skill-Auto-Trigger fehlt — "TI weiterbauen" / "Rules ablösen" springt nichts an.
- Rules-zu-TI Migration-Playbook fehlt (Rule-Inventar → Output-Coord-Drift → Feeder-Migration → Acceptance).

## Nice-to-have

- Sandbox-Mgmt
- MDX-Pre-Flight-Validation
- Replication
- Process-Versionierung

## Analyse / Sinnhaftigkeit (2026-05-01)

### High-Impact Tools

**1. `tm1_import_pro_file` — JA, Priorität 1**
- Pro: Massive Token-Ersparnis (1600 Zeilen Inline → File-Ref). Atomar deploy.
- Contra: `.pro`-Parser ~200-300 LOC. Format semi-dokumentiert aber stabil.
- ROI hoch. Foundation für #2 + #5.

**2. `tm1_diff_process_with_file` — JA, nach #1**
- Lebt von Parser aus #1. Wertvoll für Brownfield-Sync.
- Effort gering wenn #1 steht.

**3. `tm1_search_code` — JA, quick win**
- Trivial: Wrapper auf `tm1_get_all_processes_code` + Regex serverseitig.
- ~50 LOC. Niedrigster Aufwand, hoher Daily-Value.

**4. `tm1_callgraph_summary` — JA, Mode-Erweiterung**
- Nicht neues Tool sondern `mode` Param für `tm1_analyze_callgraph`.
- OOM-Prevention real (1.8 MB-Output dokumentiert).
- ~30 LOC im existing tool.

**5. `tm1_install_pro_bundle` — Optional**
- Reine Komposition: loop über #1.
- Userspace via Bash-Loop machbar. Tool-Wert: atomare Fehlerberichte/rollback.
- Nice aber kein Muss.

**6. `tm1_upsert_process` — Erst REST checken**
- TM1 `PUT /Processes('name')` mit full body sollte das eigentlich schon können.
- Wenn ja: nur Tool-Wrapper. Wenn nein: 3 Calls in try/finally.
- TM1 selbst supportet keine echte Transaktion — Atomicity-Argument schwächer als gedacht.

**7. Bedrock-Version-Detection — Skill, nicht Tool**
- Regex `Ver 4\.0` im Prolog. Library-spezifisch (Bedrock).
- Gehört in Skill (`tm1-bedrock`), nicht in generischen MCP-Server.
- Skip im MCP-Backlog.

### Quality-Gates

**8. Pre-Write Rule-Check — Light-Version JA, Voll-Version skip**
- Real-world Bug (3 verlorene Cycles laut memory).
- Voll: Rule-LHS-Pattern-Matching = ~500 LOC mit Edge-Cases. Overkill.
- Light: einfacher `rule-overlap-warn` der nur prüft ob Cube überhaupt Rules hat → "Achtung Rules vorhanden, manuell prüfen". ~30 LOC.

**9. Dim-Name-Verifikation — JA, narrow scope**
- Compile-passed-runtime-crash echtes Problem.
- Scope eingrenzen: SubsetCreate / ViewCreate / `[dim].[el]`-Refs in Cube-Calls.
- Existing `tm1_check_process_code` erweitern um post-compile dim-resolve-pass.

**10. N-Level vs Consolidated — JA, einfach**
- Element-Type-Lookup via existing Element-API.
- Pre-Deploy besser als Run-Time (kein Side-Effect).
- ~80 LOC.

**11. Output-Coord-Drift — NEIN**
- Pattern zu spezifisch (Loop-Vars vs Rule-RHS-Pin).
- High false-positive risk. Schwer generalisierbar.
- Gehört in Skill / manuelles Review, nicht MCP-Tool.

### Empfehlung Reihenfolge

1. `tm1_search_code` (1-2 h, sofortiger Daily-Value)
2. `tm1_callgraph_summary` Mode-Param (1 h)
3. `tm1_import_pro_file` (1 Tag, Foundation)
4. `tm1_diff_process_with_file` (4 h, build on #3)
5. Dim-Name-Verifikation in `tm1_check_process_code` (4 h)
6. N-Level-Check als pre-write tool (3 h)
7. `tm1_upsert_process` — erst REST-Check ob PUT atomar
8. Light Rule-Overlap-Warn (1 h)
9. `tm1_install_pro_bundle` (optional)

**Skip**: Bedrock-Version-Detection (Skill), Output-Coord-Drift (Skill), Voll-Pre-Write-Rule-Check (zu komplex).
