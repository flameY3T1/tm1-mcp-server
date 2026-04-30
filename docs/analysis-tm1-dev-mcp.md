# Analyse: tm1-dev-mcp → tm1-mcp-server

Vergleich des MCP-Servers `/home/user/tm1-dev-mcp` mit eigenem Server zur Identifikation übernehmenswerter Patterns.

Datum: 2026-04-30

---

## Top-5 Übernahmen (priorisiert)

### 1. Defensiver Start — `connect()` in try/catch
- **Datei:** `src/index.ts:19`
- **Problem:** TM1 down beim Start = MCP-Server crasht. Claude bekommt keinen Fehler, kein Tool-Listing.
- **Vorbild:** `tm1-dev-mcp/src/index.ts:19-28, 45-80`
- **Fix:**
  - Wrap `tm1Client.connect()` in try/catch — log warn, weitermachen
  - `request()` ruft `ensureSession()` → retry on first tool call automatisch
  - Zusätzlich: `SIGHUP`, `stdin end/close`, `uncaughtException`, `unhandledRejection` Handler
  - `shuttingDown` Flag gegen doppelten Shutdown
- **Aufwand:** ~30 Zeilen
- **Status:** **DONE 2026-04-30**

### 2. `fileops` Kategorie neu anlegen
- **Vorbild:** `tm1-dev-mcp/src/tm1-client.ts:1091-1133`, `src/tools/fileops/`
- **Tools:** `listFiles`, `getFileContent` mit v11/v12 Fallback (`Contents('Files')` → `Contents('Blobs')`)
- **Voraussetzung:** `requestRaw` Methode in Client für Binär/Text
- **Verbesserung:** Mime-type detection + size limit (TM1 Blobs können MB groß werden, MCP Antwort hat Limits). Optional `head`-Parameter für N erste KB.
- **Status:** **DONE 2026-04-30** — `tm1_list_files`, `tm1_get_file_content` mit `maxBytes` (default 256 KB, hard max 4 MB) und `headLines` Parameter. Client `requestRaw`, `listFiles`, `getFileContent`.

### 3. `check-cube-rule` Tool
- **Vorbild:** `tm1-dev-mcp/src/tm1-client.ts:179-188`
- **Endpoint:** `POST /api/v1/Cubes('{name}')/tm1.CheckRules`
- **Wert:** Syntax-Check vor `update-cube-rules` write — Safety-Gate für AI-getriebenes Rule-Editing
- **Verbesserung:** Auto-Aufruf vor jedem `update-cube-rules` (pre-write validation)
- **Status:** **DONE 2026-04-30** — `tm1_check_cube_rule` Tool, Client `checkCubeRule()`

### 4. Orphan-Session Fix in `SessionManager.authenticate()`
- **Datei:** `src/session-manager.ts:21`
- **Problem:** Re-Auth nach 401 leakt alte Session auf TM1-Server. Über Zeit accumulation → Lizenz/Thread-Limits.
- **Vorbild:** `tm1-dev-mcp/src/session-manager.ts:22-27`
- **Fix:**
  ```ts
  if (this.sessionCookie) {
    try { await this.logout(); } catch { /* ignore */ }
  }
  ```
- **Verbesserung:** Logout-Fehler swallow (alte Session evtl. schon weg)
- **Status:** **DONE 2026-04-30**

### 5. `cancel-thread` + `get-sessions` für Monitoring
- **Vorbild:** `tm1-dev-mcp/src/tm1-client.ts:895-900`
- **Endpoints:**
  - `POST /api/v1/Threads({id})/tm1.CancelOperation`
  - `GET /api/v1/Sessions?$expand=Threads,User($select=Name)`
- **Wert:** Eigener Server zeigt Threads, kann sie nicht killen. Sessions komplett blind.
- **Verbesserung:** `cancel-thread` mit Confirmation-Pattern (force=true Flag), Logging wer was gekillt hat. Bei `get-sessions` Idle-Time-Filter (`?$filter=Active eq true`).
- **Status:** **DONE 2026-04-30** — `tm1_cancel_thread` war bereits da; neu: `tm1_list_sessions` mit `activeOnly` + `withThreads` Filtern. `cancelThread`/`getSessions` Client-Methoden.

---

## Skip (eigener Server schon gleichwertig oder besser)

- **Retry-Logik** — eigener `tm1-client.ts:68-69` hat `isSafeMethod` Guard. Dev retried alles, auch POST `tm1.Execute` → Duplicate-Execution-Risk. Eigene Lösung behalten.
- **Architektur, Config, Logger, Types, Tests, package.json, tsconfig** — identisch oder Superset.

## Eigener Server hat zusätzlich

Kategorien `analysis`, `model-building`, `scheduling`, `security`, `subsets`, `views`, `operations` + `src/lib/callgraph/` sind in `tm1-dev-mcp` NICHT vorhanden.

---

## Implementierungsreihenfolge

1. ~~#4 Session-Fix~~ (5 Zeilen, kein Risk) **DONE**
2. ~~#1 Startup-Hardening~~ (30 Zeilen, low risk) **DONE**
3. ~~#3 check-cube-rule~~ (small tool, big safety-gain) **DONE**
4. ~~#5 cancel-thread + get-sessions~~ (cancel war schon da, sessions neu) **DONE**
5. ~~#2 fileops~~ (größter Brocken, neue Capability) **DONE**

---

## Alle Top-5 erledigt 2026-04-30.

Commit: `a3d3de3` — auf `origin/main` gepusht.

---

## Nächste Session — offene Punkte

### Tests fehlen für neue Code-Pfade
- `tm1-client.checkCubeRule()` — kein Unit-Test
- `tm1-client.getSessions()` — kein Unit-Test (bestehender `getThreads`-Test als Vorlage)
- `tm1-client.listFiles()` / `getFileContent()` — kein Unit-Test, v12→v11 Fallback ungetestet
- `tm1-client.requestRaw()` — 401-Retry-Pfad ungetestet
- `session-manager.authenticate()` Logout-vor-Auth — kein Test

### Ideen-Verbesserungen
- **Auto pre-write check:** `tm1_update_cube_rules` könnte intern `checkCubeRule()` aufrufen und bei Syntax-Fehlern abbrechen (aktuell muss AI das selbst kombinieren). Optional `--force` Flag für Override.
- **Property-Test** für v12→v11 Fallback: random Pfade, beide Container-Varianten.
- **fileops Schreib-Operation:** dev-mcp hat kein `uploadFile`, lohnt sich als Custom-Erweiterung (POST `/Contents('Files')/Contents` mit `Name` + `Content`)?

### Live-Test gegen TM1
- Connect, list-files, get-file-content vs. echtem Server probieren — v11 Blob-Fallback funktioniert?
- check-cube-rule mit absichtlich kaputter Rule probieren — Line-Number korrekt?
- list-sessions auf produktivem Server — Datenmenge ok für MCP-Response?

### Pre-Existing Status
- 21 Test Files, 177 Tests pass
- `tsc --noEmit` clean
- main branch up-to-date mit origin
