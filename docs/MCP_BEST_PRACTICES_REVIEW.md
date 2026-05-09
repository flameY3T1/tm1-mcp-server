# MCP Best-Practices Review — tm1-mcp-server 2.0.0

Review-Datum: 2026-05-09
Spec-Quelle: `example-skills/mcp-builder/reference/mcp_best_practices.md`
Repo-Stand: commit `bdd5303` (main), 107 Tool-Files, MCP SDK 1.29.0.

## Verdict

**8.5 / 10.** Solide Basis, post-2.0.0 Service-Split sauber, Cross-Cutting via Proxy zentralisiert. Hauptlücken: Response-Format-Duo (json/markdown), README-Drift, restliches `isError`-Boilerplate.

---

## Strengths (passt zur Spec)

| Best-Practice | Status | Evidenz |
|---|---|---|
| Server naming `{service}-mcp-server` | OK | `package.json` name `tm1-mcp-server` |
| Tool naming `{service}_{action}_{resource}`, snake_case | OK | alle Tools `tm1_*` prefix |
| Transport stdio für lokales Setup | OK | `StdioServerTransport` in `src/index.ts:159` |
| stdio-Logging nur stderr | OK | `src/logger.ts` `destination: 2`; einziger `console.*` ist `console.error` im Fatal-Handler |
| Annotations (readOnly/destructive/idempotent) | OK | `ANNOTATION_MAP` 98 Einträge, Proxy in `src/index.ts` wirft wenn fehlt |
| `outputSchema` + `structuredContent` | OK | `OUTPUT_SCHEMA_MAP` 97 Einträge, Proxy routet auto auf `registerTool`, parsed JSON-Body in `structuredContent` |
| Pagination `total/count/offset/has_more/next_offset/items` | OK | `src/tools/pagination.ts`, default 50/page, max 500, `fetchAll` opt-in mit Risiko-Warnung |
| Schema-Validation via Zod | OK | überall in `src/tools/**` |
| Auth via env, niemals in MCP-config | OK | dotenv, README warnt explizit gegen `env:` in `.mcp.json` |
| Secret-Redaction in Logs | OK | pino `redact` für `password`, `Authorization`, `TM1SessionId` |
| Uniform Error-Shape mit `hint` | OK | `error-format.ts` Proxy normalisiert: `{code, message, httpStatus?, endpoint?, details?, hint}` |
| Actionable Hints | OK | `hintForCode()` mappt Codes auf konkrete Follow-up-Tools (z.B. `NOT_FOUND` → "use list_*/get_* to enumerate") |
| Tool-Beschreibungen mit Projection/Filter-Optionen | OK | z.B. `tm1_list_cubes` dokumentiert `nameContains`, `nameRegex`, `includeDimensions=false` für Payload-Reduktion |
| CI-Gate gegen Regression | OK | `lint:no-flat-api` blockt deprecated flat-API |

---

## Gaps (Lücken zur Spec)

### G1 — Response-Format-Duo fehlt (mittel)
Spec: "Support both JSON and Markdown formats. JSON for programmatic, Markdown for human readability."

Status: alle Tools liefern `JSON.stringify(...)` als text-content. Kein `response_format: "json"|"markdown"` Param.

Impact: Agent-Konsum OK (Proxy attached `structuredContent`), Mensch-Lesbarkeit von Text-Output schlecht (Roh-JSON in Chat).

Fix: für list/get-Tools optionalen `format: z.enum(["json","markdown"]).default("json")` Param. Markdown-Renderer pro Domain (cubes-table, dim-tree). Niedrige Prio bis User es vermisst.

### G2 — README Tool-Count-Drift (klein, schnell)
README claimed `98 tools`. Aktuell:
- `ANNOTATION_MAP`: 98
- `OUTPUT_SCHEMA_MAP`: 97
- Tool-files in `src/tools/**`: 107 (inkl. ~7 helper-files → ~100 tools)

Fix: `npm run tools:list` schon vorhanden. README per `tools:update-readme` neu generieren, in CI prüfen.

### G3 — `isError` Boilerplate restdupliziert (klein)
Proxy in `index.ts` normalisiert thrown errors zu uniformer Shape. Trotzdem 19 Tool-Files emittieren manuell:
```ts
return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
```
35 Tools nutzen `isError: true` insgesamt (manche mit eigenen Payloads, OK).

Impact: kein funktionaler Bug (Proxy reshaped sie via `normalizeErrorResult`). Aber doppelter try/catch, doppelte Pfade.

Fix: try/catch aus Tools entfernen, throw rauf, Proxy übernimmt. Per Codemod oder manuell. Sparen ~150 LOC.

### G4 — `hint` ist Code-generic, nicht Tool-context (klein)
Hint-Map liefert pro `TM1ErrorCode` einen Satz. Spec-Beispiel zeigt context-specific hint ("Try filter='active_only' to reduce results").

Impact: Agent bekommt Aktion, aber nicht ideal targeted.

Fix optional: pro Tool optionaler `hintOverride`-Param an Error-Throw, Proxy mergt. Niedrige Prio — aktueller Hint schon besser als Spec-Minimum.

### G5 — Doku: 3+ Beispiele pro Major-Feature (klein)
Spec: "at least 3 working examples per major feature". README/`docs/` listen Tools, aber wenig Code-Beispiele (MDX-Patterns, Bulk-Upsert-Bundle, .pro-Lifecycle).

Fix: `docs/EXAMPLES.md` mit MDX-Query, Process-Upsert, Chore-Schedule, Bulk-Element-Upload je 1-2 Snippets. Niedrige Prio.

### G6 — Streamable-HTTP-Transport (defer)
Backlog #13. stdio reicht für 1-User-Setup. HTTP nur wenn Multi-Client/Cloud-Deploy gewünscht. **Defer.**

---

## Out-of-Scope (Spec-konform OK)

- DNS-Rebinding/Origin-Validation: nicht relevant für stdio.
- OAuth 2.1: nicht anwendbar, TM1 nutzt Basic Auth via env.
- Rate-Limiting: TM1-Server-seitig, nicht MCP-Layer.

---

## Action-Items (priorisiert)

| # | Gap | Aufwand | Prio |
|---|---|---|---|
| 1 | README tool-count via `npm run tools:update-readme` aktualisieren + CI-check | XS | hoch |
| 2 | `isError`-Boilerplate aus 19 Tool-Files raus → throw nutzen | M | mittel |
| 3 | `docs/EXAMPLES.md` schreiben (3 Beispiele pro Top-Feature) | S | mittel |
| 4 | `format: "json"\|"markdown"` für list/get-Tools | L | niedrig |
| 5 | Per-Tool `hintOverride`-Param für context-specific hints | S | niedrig |
| 6 | Streamable-HTTP-Transport (Backlog #13) | L | defer |

## Score-Breakdown

- Naming/Structure: 10/10
- Annotations/Schemas: 10/10
- Pagination: 10/10
- Error-Handling: 9/10 (boilerplate-rest)
- Security/Auth: 10/10
- Response-Formats: 6/10 (kein markdown-mode)
- Documentation: 7/10 (drift + dünne Examples)
- Transport: 8/10 (stdio only — by design)

**Total: 8.5 / 10**
