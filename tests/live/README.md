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
