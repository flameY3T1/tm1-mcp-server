# Live integration tests

These suites exercise the **real MCP tool layer against a running TM1 server**.
Every call goes through the same path an MCP client uses: the tool's zod input
schema (defaults + validation), the `withAnnotations` wrapper (annotation
injection, error normalization, output-schema attach), the real handler, the
real `TM1Client`, and real OData. They are the complement to the mocked unit
tests under `tests/unit/` — those prove the logic in isolation; these prove the
calls actually work end-to-end against TM1 11.x.

## Opt-in — never runs by default

The default `vitest.config.ts` does **not** include `tests/live`, so
`npm test` / `npm run verify` never touch the network. Live tests run only via
their own config and only when a server is configured:

```bash
TM1_BASE_URL=https://host:port TM1_USER=admin TM1_PASSWORD=... npm run test:live
```

Without `TM1_BASE_URL` + `TM1_USER` in the environment, every suite skips itself
(`describe.skipIf(!LIVE_ENABLED)`), so the command is also safe to run blind in
CI — it just reports skipped. Credentials come from the environment / `.env`
(git-ignored) and are never committed.

## There is no CI live coverage — and none is planned

**Read this before you assume the tool surface is continuously verified against
a real TM1: it is not.** Live coverage exists only for the minutes in which
somebody runs these suites against a reachable server. Nothing on GitHub does.

The reason is routing, not effort. The TM1 servers this project is developed
against sit on a private network (the Windows host of a WSL box). A
GitHub-hosted runner cannot reach them. A scheduled workflow *could* be added
and would go green every night — because without `TM1_BASE_URL` + `TM1_USER`
every suite self-skips — but that green would mean "nothing was tested", and a
badge that says "passing" for a run that verified nothing is worse than no
badge at all. So that job deliberately does not exist.

Two honest ways to close the gap:

- **Run the scheduled script below** on a machine that can reach a TM1 server
  (the developer's WSL box, or any host with a route to the server).
- **Recorded-fixture contract suite** (Tier 6 item 1 of the 2026-08-05 review):
  check in sanitized real responses and assert the parsers against them in the
  normal CI, with no server involved. That is the only variant that can ever be
  server-free. **It is not built yet.** Until it is, CI proves the code is
  self-consistent, not that TM1 still answers the way it did.

## Scheduled run — `npm run test:live:nightly`

`scripts/run-live-nightly.mjs` runs the live suite against one or more targets,
writes a timestamped report, and exits with a code the scheduler can branch on.

```bash
npm run test:live:nightly                        # tm1-test (v11) + tm1-v12
npm run test:live:nightly -- --targets=tm1-test  # one target
npm run test:live:nightly -- --filter=process    # narrow to matching files
npm run test:live:nightly -- --help              # all options
```

**Credentials.** Never from a committed file. Two sources:

- `--target=<name>` reads the `mcpServers.<name>.env` block from `.mcp.json`
  (git-ignored, holds `TM1_PASSWORD`) — the same config the interactive MCP
  servers use, so a scheduled run and a hand-driven session hit identical
  settings. Override the path with `--mcp-config=PATH`.
- `--target=env` uses the ambient environment (`TM1_BASE_URL`, `TM1_USER`,
  `TM1_PASSWORD`, …) — for CI-ish setups that inject secrets themselves.

Per target the script **strips every `TM1_*` variable** before applying that
target's block. That is load-bearing: `loadConfig()` picks v12 purely from the
presence of `TM1_INSTANCE` / `TM1_DATABASE`, so one leftover v12 variable —
from your shell or from the previous target in the same run — silently reroutes
a v11 target into the v12 login path. Secret values (`TM1_PASSWORD`,
`TM1_CLIENT_SECRET`, `TM1_CLIENT_ID`, tokens) are redacted from everything the
script prints or writes.

**Reports** land in `.live-reports/` (override with `--out=DIR`) as
`live-<UTC timestamp>.log` plus `latest.log`, newest 30 kept (`--keep=N`). The
`.log` suffix is deliberate — it is already covered by the `*.log` rule in
`.gitignore` and ignored by prettier, so a report can never show up as a repo
diff. The report holds the full vitest output; the console keeps the summary.

**A down server is not a failed test.** These boxes get switched off and are
slow to serve after a cold start, so the script separates the two:

| Status | Meaning | Exit |
|--------|---------|------|
| `PASS` | suite ran and passed | 0 |
| `FAIL` | tests ran and failed → **real contract drift** | 1 |
| `TIMEOUT` | killed at `--timeout-min` (default 30) | 1 |
| `UNREACHABLE` | pre-flight probe got no answer (box off, refused, timeout) | 3 |
| `NOT READY` | probe got 502/503/504 — TM1 up, still starting | 3 |
| `TLS BLOCKED` | cert rejected — config problem, not drift | 3 |
| `CONNECT FAILED` | red run that never reached one assertion (401, refused login) | 3 |
| `LOST SERVER` | run went red **and** the post-mortem probe finds the server gone | 3 |
| `NOTHING RAN` | exit 0 but zero tests executed — everything skipped | 3 |
| `MISCONFIGURED` | no `TM1_BASE_URL`/`TM1_USER`; the suite would silently skip | 2 |

Exit 3 means *nothing was verified*. It is intentionally not 0: a run that
checked nothing must never read as a pass. Pass `--allow-unreachable` to
downgrade it to 0 if your scheduler mails on every non-zero exit.

**Scheduling it — you install this, not the repo.** Nothing here touches your
crontab or systemd. Add one of the following by hand.

Cron (`crontab -e`) — 03:17 local, off the hour so it does not collide with
everything else that fires at :00, and outside working hours so the run has the
test server to itself:

```cron
17 3 * * * cd /home/niklas/tm1-mcp-server && /home/niklas/.local/share/fnm/node-versions/v26.2.0/installation/bin/node scripts/run-live-nightly.mjs >> /home/niklas/tm1-mcp-server/.live-reports/cron.log 2>&1
```

The absolute node path is required: cron gets a bare `PATH` and fnm's shim
directory is per-shell. Update the path when you switch node versions
(`readlink -f "$(which node)"` prints the current one).

systemd user timer (`~/.config/systemd/user/tm1-live.service` +
`tm1-live.timer`, enable with `systemctl --user enable --now tm1-live.timer`;
needs `loginctl enable-linger $USER` to fire while logged out):

```ini
# tm1-live.service
[Service]
Type=oneshot
WorkingDirectory=/home/niklas/tm1-mcp-server
ExecStart=/home/niklas/.local/share/fnm/node-versions/v26.2.0/installation/bin/node scripts/run-live-nightly.mjs

# tm1-live.timer
[Timer]
OnCalendar=*-*-* 03:17:00
Persistent=true
[Install]
WantedBy=timers.target
```

**Troubleshooting.** A `CONNECT FAILED — 401` usually means credentials, but
mind the second-order effect: TM1's `MaximumLoginAttempts` **disables the
client account** after enough failed logins, so a few bad runs can lock out
`admin` until it is re-enabled server-side (Architect → Security → Clients, or
another admin account). This is why the script never retries a failed login.

## Safety model

- **Sandbox namespace.** Everything created is prefixed `ZZ_MCP_LIVE_<DOMAIN>`
  (see `SANDBOX` in `harness.ts`). No real model object is ever touched.
- **Lifecycle, not blind matrix.** Each domain runs a real
  create → read → update → delete chain, so destructive tools are covered in a
  controlled context rather than fired at production objects.
- **Idempotent cleanup.** Each file tears down its own objects in `afterAll`;
  `global-setup.ts`'s `teardown` is a safety net that sweeps any
  `ZZ_MCP_LIVE`-prefixed leftovers (including `}Subsets_…` control objects)
  after the whole run, in dependency order (chores → processes → cubes → dims).
- **Avoided:** `tm1_get_transaction_log` (slow full-scan / timeout trap) and
  `tm1_save_data` (global flush).

## Layout

| File | Domain |
|------|--------|
| `harness.ts` | shared infra: connect, capture handlers, `call`/`ok`, `sweepSandbox` |
| `global-setup.ts` | vitest globalSetup; `teardown` = safety-net sweep |
| `read-smoke.live.test.ts` | non-mutating read battery + error-envelope checks |
| `dimension.live.test.ts` | dimensions / hierarchies / elements / attributes / subsets-of-dim |
| `cube.live.test.ts` | cubes / cells / rules / MDX |
| `view.live.test.ts` | native + MDX views / subsets |
| `process.live.test.ts` | TI processes (upsert / compile / execute / diff / diagnose) |
| `chore.live.test.ts` | chores (deactivated; create / toggle / execute / delete) |
| `ops.live.test.ts` | server / monitoring / security / files |
| `analysis.live.test.ts` | read-only audits over the existing model |

## Writing a new live test

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: my domain", () => {
  let h: LiveHarness;
  beforeAll(async () => { h = await getHarness(); });

  it("does a thing", async () => {
    const r = await h.ok("tm1_some_tool", { name: `${SANDBOX}_MINE_X` });
    expect(r.json).toMatchObject({ /* ... */ });
  });
});
```

- `h.call(name, args)` returns `{ result, json, text, isError }` and never throws
  on a TM1 error — assert on `isError` / `json.code` for negative paths.
- `h.ok(name, args)` throws if the tool returned an error envelope — use for
  steps that must succeed.
- Prefix **every** created object with `${SANDBOX}_<DOMAIN>` and delete it in
  `afterAll` (the global sweep is a backstop, not a substitute).
