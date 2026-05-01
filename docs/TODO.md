# TM1 MCP Server — Backlog

Source: `~/.claude/projects/-home-user-tm1-ai-dev/memory/` (project_mcp_tool_gaps.md, project_lifecycle_gaps.md, reference_mcp_callgraph_tools.md). Captured 2026-05-01.

## High-Impact Tools (Token-burn / Workflow-Reibung)

- [ ] **`tm1_import_pro_file`** — Parse `.pro` (Tabs/Params/DataSource) + 1-Call deploy. Heute: 4 Tabs als Inline-String (1600+ Zeilen) via `tm1_update_process_code` + separate `tm1_update_process_parameters`.
- [ ] **`tm1_diff_process_with_file`** — Installed vs `.pro` Datei: Param-Diff + Code-Diff. Heute manuell via Read+Vergleich.
- [ ] **`tm1_search_code`** — Regex über alle TI-Code (Wrapper auf `tm1_get_all_processes_code` + lokaler Grep). Heute: bulk-load + Bash-grep.
- [ ] **`tm1_callgraph_summary`** — `mode: "summary"` für `tm1_analyze_callgraph` (Caller-Counts + flache Liste statt full Tree). Vermeidet 1.8 MB OOM-Output bei großen Trees.
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
