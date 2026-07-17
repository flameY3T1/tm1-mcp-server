# v12 Jobs / Activity — design spec

**Date:** 2026-07-17
**Status:** approved, ready for implementation plan
**Follow-up to:** `docs/superpowers/specs/2026-07-17-v12-connection-design.md` (Out of Scope → "v12 Jobs / Activity")

## Problem

In TM1 v11, long-running server work is introspected and cancelled through
**Threads** (`GET /api/v1/Threads`, cancel via
`POST /api/v1/Threads({id})/tm1.CancelOperation`). Our tools
`tm1_list_threads` and `tm1_cancel_thread` (plus the abort hint in
`tm1_execute_process`) rely on this.

In TM1 v12 (Planning Analytics Engine) the model changed. Verified live against
a real PAE 12.5.9 server:

- `GET /Threads` → `200 {"value":[]}` — **empty at rest**; v12 threads are
  ephemeral (per-request), so `/Threads` no longer shows running work.
- `GET /ActiveThreads` → **404** (`code 278`, resource cannot be resolved).
- `GET /Jobs` → `200 {"value":[]}` — the new **Activity** surface: an active
  task on a specific database replica.
- `/Threads` and `/Jobs` live under the **database-scoped** OData service
  (`/{instance}/api/v1/Databases('{db}')/...`), already handled by the v12
  connection profile's `resolveApiPath` rerooting.

Result: on a v12 connection, `tm1_list_threads` returns nothing useful and
`tm1_cancel_thread` cannot target real work. The abort/monitor workflow is
broken on v12.

## Verified REST facts (live, PAE 12.5.9)

From the database-scoped `$metadata`:

**`tm1.Job` entity** (added 12.2.0) — *"Represents an active task on a specific
database replica."*
- `ID` — `Edm.String`, key (**string**, unlike Thread's `Edm.Int64`).
- `Description` — `Edm.String`, human-readable.
- `State` — `tm1.JobState` (enum; surfaced as raw string).
- `ElapsedTime` — `Edm.Duration` (ISO-8601 duration string).
- `WaitTime` — `Edm.Duration`, nullable.
- Nav `WaitingOn` — `Collection(tm1.Job)` — jobs blocking this one (added
  **12.3.0**; may be absent on older v12).
- Nav `Session` — `tm1.Session`.
- Nav `Replica` — `tm1s.DatabaseReplica`.

**Cancel action:** `<Action Name="Cancel" IsBound="true">` — *"Cancels a Job."*
→ `POST /api/v1/Jobs('{id}')/tm1.Cancel`. (`tm1.CancelOperation` also still
exists in v12 metadata, bound to Thread; not used here.)

**`Thread` entity** is still fully defined in v12 metadata — the endpoint
exists, it is simply empty at rest.

## Approach

**Version-gated tool registration.** The configured connection version
(`config.version` = `11 | 12`, set by `loadConfig` and fixed for a connection's
lifetime) decides which tools a server instance exposes:

- v11 connection → `tm1_list_threads` + `tm1_cancel_thread` registered; job
  tools absent.
- v12 connection → `tm1_list_jobs` + `tm1_cancel_job` registered; thread tools
  absent.

Rejected alternative: registering both sets always and returning an `isError`
"not on this version" from the wrong-version tool. Version-gating gives a
cleaner MCP tool list (no dead tools) and is the user-approved shape.

### Why this does not break the build gates

The coverage/registration checkers and the README generator are **static
source scanners** (`scripts/lib/scan-tools.mjs`): they find `server.tool("name",
…)` string literals in `src/tools/**`, independent of any runtime `if (version
=== …)` wrapping. Therefore:

- `check-tool-registration` — passes: every `register*` export stays wired into
  the `REGISTRARS` array (the early-return is inside the function).
- `check-annotation-coverage` / `check-output-schema-coverage` — pass: both the
  job and thread `server.tool(...)` literals remain in source, so both need (and
  get) entries in `annotation-map.ts` and `output-schema-map.ts`. No "unused
  key" errors because both literals are present.
- `gen-tool-list` (README) — lists **both** sets; descriptions carry a
  "(v11 only)" / "(v12 only)" label.

## Components

### 1. Version accessor — `TM1Client`

Add `get version(): 11 | 12` to `src/tm1-client.ts`, reading the private
`config.version`. This is the seam registrars and version-aware hints read. No
tool reads version today; this is the first consumer.

### 2. Service layer — `MonitoringService` (`src/tm1-client/services/monitoring-service.ts`)

`async getJobs(): Promise<Job[]>`
- `GET /api/v1/Jobs?$select=ID,Description,State,ElapsedTime,WaitTime`
  `&$expand=Session($select=ID,Context;$expand=User($select=Name)),`
  `WaitingOn($select=ID,Description,State)`
- Maps each to `Job`:
  `{ id, description, state, elapsedTime, waitTime?, session?: { id, context, user }, waitingOn?: Array<{ id, description, state }> }`
- Tolerates missing `Session` / `WaitingOn` / `WaitTime` (nested optional guards,
  mirroring the existing `getSessions` mapping style). `WaitingOn` absent on
  pre-12.3 servers → omit the field.
- Rerooting is automatic via the v12 http profile.

`async cancelJob(jobId: string): Promise<void>`
- `POST /api/v1/Jobs('{esc}')/tm1.Cancel` with body `{}`.
- `jobId` single-quotes escaped via the existing OData key encoder used
  elsewhere in the service layer (`encKey` / `''` doubling).

### 3. Types — `src/types.ts`

Add `Job` interface (and its nested `session` / `waitingOn` shapes) alongside
the existing `Thread` / `Session` types.

### 4. Tools — `src/tools/operations/get-jobs.ts` (new)

`registerJobTools(server, tm1Client)`:
- Early return `if (tm1Client.version !== 12) return;`.
- `tm1_list_jobs` (READ_ONLY): calls `monitoring.getJobs()`, returns the
  page-shaped job list (same envelope pattern as `tm1_list_threads`).
- `tm1_cancel_job` (DESTRUCTIVE): input `{ jobId: string }`, calls
  `monitoring.cancelJob(jobId)`, returns `{ success: true, jobId }`. Mirrors
  `tm1_cancel_thread` exactly — **no confirm-guard** (matches the existing
  cancel-thread behavior; do not add one this task).

`registerThreadTools` (existing `get-threads.ts`): add early return
`if (tm1Client.version !== 11) return;` guarding both `tm1_list_threads` and
`tm1_cancel_thread`.

Wiring: `registerJobTools` imported and added to `REGISTRARS` in
`src/tools/index.ts`. Run `npm run tools:update-readme` after.

### 5. Version-aware hints & descriptions

- `tm1_execute_process` abort hint (`src/tools/ti-development/execute-process.ts`):
  branch on `tm1Client.version` — v12 → "Use `tm1_list_jobs` to check for it and
  `tm1_cancel_job` to stop it."; v11 → the current threads wording. This tool is
  always registered, so the branch (not registration-gating) is required here.
- `tm1_list_sessions` (`src/tools/operations/get-sessions.ts`) stays **always
  registered** (works on both versions). Its description currently says "Pair
  with `tm1_list_threads` / `tm1_cancel_thread`" — make it version-aware
  (v12 → jobs) or version-neutral so it never names an absent tool.

### 6. Output schemas — `src/tools/schemas/` + `src/tools/output-schema-map.ts`

- New `JobItemSchema` (strict `z.object`, every field the handler emits, matching
  the `Job` type incl. optional `session` / `waitingOn`).
- `tm1_list_jobs: pageShapeFor(JobItemSchema)`.
- `tm1_cancel_job: asOutputSchema(MutationResultSchema)`.
- `tm1_list_jobs` / `tm1_cancel_job` entries in `annotation-map.ts`
  (READ_ONLY / DESTRUCTIVE).

## Error handling

- Wrong-version invocation is impossible via MCP (tool not registered), so no
  runtime version guard needed inside the tools.
- `cancelJob` on a finished/unknown job → server returns an error; surfaced as
  the tool's `isError` result (same as `cancel_thread` today).
- Job IDs are quote-escaped before interpolation into the OData key.

## Testing

**Unit:**
- `getJobs` field mapping: full payload (with `Session` + `WaitingOn`) →
  correct `Job[]`; payload missing `Session` / `WaitingOn` / `WaitTime` → those
  fields omitted, no throw.
- `cancelJob`: correct URL `Jobs('<id>')/tm1.Cancel`, POST, quote-escaping for an
  id containing `'`.
- Registration gating: `registerJobTools` with a v11-configured client registers
  **no** tools; with v12 registers both. `registerThreadTools` inverse. (Assert
  via a mock `server.tool` spy.)

**Live** (extend `tests/live/v12-connection.live.test.ts` or a sibling,
`skipIf(!isV12)`):
- `tm1_list_jobs` / `getJobs()` returns an array (likely empty on an idle
  server) — assert it is an array and shape-valid.
- `cancelJob('nonexistent')` → expect a rejection/error (negative path).

**Out of scope for tests:** staging a real long-running job to observe a
populated `/Jobs` (would require a concurrent slow process against the live
server); asserted shape + empty-list + cancel-error path is the coverage.

## Docs

- README: the four monitoring tools labelled "(v11 only)" / "(v12 only)";
  regenerated via `tools:update-readme`.
- `CHANGELOG.md` `[Unreleased]` → `Added`: v12 Jobs support
  (`tm1_list_jobs` / `tm1_cancel_job`, version-gated thread/job tools).

## Out of scope (future follow-ups)

- Job **history** / completed-Activity view (only in-progress `/Jobs` here).
- Staging real jobs in the live suite.
- Cloud **PAaaS** tenant URL shape (tracked in the connection spec).
- A confirm-guard for `tm1_cancel_job` (mirror cancel_thread's current
  no-guard behavior; revisit only if cancel_thread gets one).
