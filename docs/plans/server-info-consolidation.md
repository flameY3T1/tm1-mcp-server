# Plan — Server-Meta Tool Consolidation

**Status:** Draft / awaiting execution
**Date:** 2026-05-26
**Scope:** Merge `tm1_get_server_capabilities` into `tm1_get_server_info`. `tm1_get_server_state` bleibt.

---

## Motivation

Drei Server-Meta-Tools, zwei holen aus identischer Quelle:

| Tool | Source | Output |
|---|---|---|
| `tm1_get_server_info` | `/Configuration` + `/ActiveConfiguration` via `tm1Client.server.getInfo()` | base fields + raw `extra` blob |
| `tm1_get_server_capabilities` | **selbiges** `info.extra` | curated grouped subset |
| `tm1_get_server_state` | `info.extra` (8 flags) + 5 live counts | health + counts |

`capabilities` = nur Curation-Layer über `info`. Keine neue API-Call. Agent muss raten welches Tool für welchen Flag.

**Ziel:** `get_server_info` liefert kuratierten Output direkt. `capabilities` Tool weg. `state` bleibt (counts sind unique).

---

## Inventory — Caller / Refs

### Code
- `src/tools/operations/get-server-capabilities.ts` — implementation (DELETE)
- `src/tools/operations/get-server-info.ts` — current dumps `info` via renderKV (REWORK)
- `src/tools/operations/get-server-state.ts:41` — uses `info.extra` directly; **independent of capabilities tool** (no change required)
- `src/tools/index.ts:92,221` — import + register call (REMOVE)
- `src/tools/annotation-map.ts:93` — `tm1_get_server_capabilities: READ_ONLY` (REMOVE)
- `src/tools/output-schema-map.ts:60,240` — import + entry (REMOVE)
- `src/tools/schemas/items.ts:64-75` — `ServerInfoSchema` (EXTEND)
- `src/tools/schemas/items.ts:665-679` — `ServerCapabilitiesResultSchema` (DELETE)

### Prompts
- `src/prompts/index.ts:83` — "Call `tm1_get_server_info` and `tm1_get_server_capabilities` first…" → drop second
- `src/prompts/index.ts:194` — "check via tm1_get_server_capabilities" → "check via tm1_get_server_info"

### Tests
- `tests/unit/output-schema-map.test.ts:130` — entry for `tm1_get_server_capabilities` (REMOVE)
- `tests/unit/output-schema-additional-properties.test.ts` — may reference, check before edit

### Docs
- `docs/EXAMPLES.md:407` — tool list mention
- `docs/MCP_BEST_PRACTICES_REVIEW.md:61` — 13 `tm1_get_*` tools → 12
- `docs/TOOL_AUDIT.md` — append decision section
- `README.md` — auto-regenerated tool list + count

---

## Open decision — raw `extra` blob

Aktuell exposes `ServerInfoSchema.extra: z.record(z.string(), z.unknown())`. Agent kann tief darin pulen, aber Schema garantiert keine Pfade.

**Option A — drop `extra` ganz:**
Saubere API, keine ungetypten Felder. Risk: power-user-paths brechen (low — schema gibt nix vor).

**Option B — behalten unter `_raw`:**
Curated fields oben, raw blob unten als escape-hatch. Größerer Payload aber max Flexibilität.

**Recommendation:** B (kostet ~nichts, vermeidet breaking change). User entscheidet vor Phase 1.

---

## Execution Phases

### P1 — Schema (`src/tools/schemas/items.ts`)
Extend `ServerInfoSchema`:
```ts
export const ServerInfoSchema = z.object({
  serverName, productVersion, productEdition?, adminHost?,
  dataDirectory?, timeZoneId?, integratedSecurityMode?,
  modelling: z.unknown(),
  ti: z.unknown(),
  rules: z.unknown(),
  mtq: z.unknown(),
  jobQueuing: z.unknown(),
  memory: z.unknown(),
  logging: z.unknown(),
  http: z.unknown(),
  security: z.unknown(),
  _raw: z.record(z.string(), z.unknown()).optional(),  // if Option B
  // extra: ENTFERNEN (oder unter _raw umbenennen)
}).passthrough();
```
Delete `ServerCapabilitiesResultSchema`.

### P2 — Rework `get-server-info.ts`
Import `pick()` helper (extract to `src/tools/operations/_helpers.ts` or duplicate; dedupes state+capabilities). Build curated payload identical to current capabilities output. Append `_raw: info.extra` if Option B.

### P3 — Delete `get-server-capabilities.ts`
Remove file. Remove registration in `tools/index.ts`, annotation, schema-map entry.

### P4 — Prompts
Edit `src/prompts/index.ts:83` + `:194` — replace `tm1_get_server_capabilities` references with `tm1_get_server_info`.

### P5 — Tests
Remove `tm1_get_server_capabilities` from `output-schema-map.test.ts`. Run suite. If `additional-properties` test fails, fix `ServerInfoSchema.passthrough()` accordingly.

### P6 — Docs
- `EXAMPLES.md` — remove from `tm1_get_*` list
- `MCP_BEST_PRACTICES_REVIEW.md` — 13 → 12 tools
- `TOOL_AUDIT.md` — append decision: "consolidated capabilities into info"
- `README.md` — regenerate via existing script (auto)

### P7 — Build + Smoke
- `npm run build`
- `npm test`
- `npm run lint`
- Live MCP test: call `tm1_get_server_info`, verify grouped sections render

### P8 — Commit + Push
`refactor(meta): merge tm1_get_server_capabilities into tm1_get_server_info — 1 tool less, same info`

---

## Risk

- **Output schema consumers:** any agent/script reading `info.extra.Modelling.X` breaks if Option A chosen. Option B mitigates.
- **renderKV output:** longer text response for `tm1_get_server_info`. Agent context cost ~+1KB per call. Acceptable.
- **`state` capabilities subset:** stays as-is (duplication of 8 flags between state + info). Justified — state is health-snapshot, kept small intentionally.

---

## Rollback

Single commit. Revert if any test or live call breaks.
