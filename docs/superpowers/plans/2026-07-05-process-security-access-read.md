# Readable HasSecurityAccess + native full-process read — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a TI process's `HasSecurityAccess` flag readable (bulk audit, opt-in with code, and via a new native full read) and give `tm1_upsert_process` a native read-twin `tm1_get_process`.

**Architecture:** Three additive changes over existing service methods — no new REST plumbing. (A) add one `$select` column to the bulk `getAllCode`; (B) new `tm1_get_process` tool that orchestrates existing per-part service getters behind include-flags; (C) opt-in flag on `tm1_get_process_code`. All reuse `getCode`/`getParameters`/`getVariables`/`getDataSource`/`getDeployMeta`.

**Tech Stack:** TypeScript (strict), MCP SDK (`server.tool`), Zod input schemas, Vitest (unit + live), pino logger.

## Global Constraints

- **Verify gate:** `npm run verify` must pass (typecheck strict + lint:no-flat-api + lint:annotations + lint:tool-registration + tests). Copy verbatim from CLAUDE.md.
- **Service composition:** no new flat-client calls; reuse `tm1Client.processes.*` service methods. Gate: `lint:no-flat-api`.
- **Tool annotations:** every tool declares a hint in `src/tools/annotation-map.ts`. Gate: `lint:annotations`.
- **Tool registration:** every `register*` export must be wired in `src/tools/index.ts` `REGISTRARS`. Gate: `lint:tool-registration`.
- **Secrets:** mask via `src/lib/mask-secrets.ts` (`MASK = "***"`, `maskCode`); never log raw creds.
- **Commits:** Conventional Commits; one logical change per commit. End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **No output schemas** on these read tools (siblings register none; keep payload open).
- **No real customer/server names** in tests or docs.

---

## Task 1: Bulk audit exposes elevation (`getAllCode`)

**Files:**
- Modify: `src/tm1-client/services/process-service.ts:324-343` (`getAllCode`)
- Test: `tests/unit/tm1-client-process.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `ProcessCode` (`src/types.ts:267`), `this.http.request`.
- Produces: `getAllCode(includeControl?: boolean): Promise<Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>>` — every row now carries `hasSecurityAccess`. Task 4's live test relies on this field.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/tm1-client-process.test.ts` (reuses the existing `mockResponse` / `fetchSpy` / `client` harness in that file):

```ts
describe("TM1Client – getAllCode security access", () => {
  it("selects HasSecurityAccess and maps it onto each row", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          {
            Name: "proc.elevated",
            PrologProcedure: "p",
            MetadataProcedure: "m",
            DataProcedure: "d",
            EpilogProcedure: "e",
            HasSecurityAccess: true,
          },
          {
            Name: "proc.normal",
            PrologProcedure: "",
            MetadataProcedure: "",
            DataProcedure: "",
            EpilogProcedure: "",
            HasSecurityAccess: false,
          },
        ],
      }),
    );

    const rows = await client.processes.getAllCode(false);

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("HasSecurityAccess");
    expect(rows[0]).toMatchObject({ name: "proc.elevated", hasSecurityAccess: true });
    expect(rows[1]).toMatchObject({ name: "proc.normal", hasSecurityAccess: false });
  });

  it("defaults missing HasSecurityAccess to false", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          {
            Name: "proc.legacy",
            PrologProcedure: "",
            MetadataProcedure: "",
            DataProcedure: "",
            EpilogProcedure: "",
          },
        ],
      }),
    );
    const rows = await client.processes.getAllCode(false);
    expect(rows[0].hasSecurityAccess).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tm1-client-process.test.ts -t "getAllCode security access"`
Expected: FAIL — `url` does not contain `HasSecurityAccess` / `hasSecurityAccess` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Replace `getAllCode` body (`src/tm1-client/services/process-service.ts:324-343`) with:

```ts
  async getAllCode(
    includeControl = false,
  ): Promise<Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const path = `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,HasSecurityAccess${filter}`;
    const response = await this.http.request<{
      value: Array<{
        Name: string;
        PrologProcedure: string;
        MetadataProcedure: string;
        DataProcedure: string;
        EpilogProcedure: string;
        HasSecurityAccess?: boolean;
      }>;
    }>("GET", path);
    return response.value.map((p) => ({
      name: p.Name,
      prolog: p.PrologProcedure ?? "",
      metadata: p.MetadataProcedure ?? "",
      data: p.DataProcedure ?? "",
      epilog: p.EpilogProcedure ?? "",
      hasSecurityAccess: p.HasSecurityAccess === true,
    }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/tm1-client-process.test.ts -t "getAllCode security access"`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/services/process-service.ts tests/unit/tm1-client-process.test.ts
git commit -m "feat(processes): expose HasSecurityAccess in bulk getAllCode

Audit bulk-load can now answer which processes run elevated.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Opt-in elevation on `tm1_get_process_code`

**Files:**
- Modify: `src/tools/ti-development/get-process-code.ts`
- Test: `tests/unit/get-process-code-security.test.ts` (create)

**Interfaces:**
- Consumes: `tm1Client.processes.getCode` (`ProcessCode`), `tm1Client.processes.getDeployMeta(name): Promise<{ hasSecurityAccess: boolean }>` (`src/tm1-client/services/process-service.ts:371`).
- Produces: `tm1_get_process_code` gains input `includeSecurityAccess: boolean = false`; when true the JSON payload has `hasSecurityAccess: boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/get-process-code-security.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerGetProcessCode } from "../../src/tools/ti-development/get-process-code.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function captureHandler(processes: Partial<TM1Client["processes"]>): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerGetProcessCode(server, { processes } as unknown as TM1Client);
  if (!cb) throw new Error("handler not registered");
  return cb;
}

const code = { prolog: "p", metadata: "m", data: "d", epilog: "e" };

describe("tm1_get_process_code includeSecurityAccess", () => {
  it("omits the flag and skips getDeployMeta by default", async () => {
    let metaCalls = 0;
    const cb = captureHandler({
      getCode: async () => code,
      getDeployMeta: async () => {
        metaCalls += 1;
        return { hasSecurityAccess: true };
      },
    });
    const res = await cb({ processName: "p1" }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.hasSecurityAccess).toBeUndefined();
    expect(metaCalls).toBe(0);
  });

  it("includes the flag via getDeployMeta when opted in", async () => {
    const cb = captureHandler({
      getCode: async () => code,
      getDeployMeta: async () => ({ hasSecurityAccess: true }),
    });
    const res = await cb({ processName: "p1", includeSecurityAccess: true }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.hasSecurityAccess).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/get-process-code-security.test.ts`
Expected: FAIL — second case: `payload.hasSecurityAccess` is `undefined` (param not yet handled).

- [ ] **Step 3: Write minimal implementation**

In `src/tools/ti-development/get-process-code.ts`, add the input flag to the schema object (after the `maskSecrets` entry):

```ts
      includeSecurityAccess: z.boolean().optional().default(false).describe(
        "Also fetch the process's HasSecurityAccess elevation flag (one extra GET). " +
          "Default false — pure code reads stay a single request.",
      ),
```

Update the handler signature to destructure it:

```ts
    async ({ processName, stripComments, maskSecrets, includeSecurityAccess }) => {
```

Then, immediately before `const payload = { ...code, ...(hint ? { hint } : {}) };`, insert:

```ts
      let hasSecurityAccess: boolean | undefined;
      if (includeSecurityAccess) {
        hasSecurityAccess = (await tm1Client.processes.getDeployMeta(processName)).hasSecurityAccess;
      }
```

And extend the payload line to:

```ts
      const payload = {
        ...code,
        ...(hasSecurityAccess !== undefined ? { hasSecurityAccess } : {}),
        ...(hint ? { hint } : {}),
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/get-process-code-security.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/tools/ti-development/get-process-code.ts tests/unit/get-process-code-security.test.ts
git commit -m "feat(get_process_code): opt-in includeSecurityAccess flag

Default false keeps pure code reads a single GET; true adds the
HasSecurityAccess elevation flag via getDeployMeta.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: New tool `tm1_get_process` (native full read)

**Files:**
- Create: `src/tools/ti-development/get-process.ts`
- Modify: `src/tools/index.ts` (import + `REGISTRARS`)
- Modify: `src/tools/annotation-map.ts` (add `tm1_get_process: READ_ONLY`)
- Test: `tests/unit/get-process.test.ts` (create)

**Interfaces:**
- Consumes: `tm1Client.processes.getCode`, `.getParameters` (`ProcessParameter[]`), `.getVariables` (`ProcessVariable[]`), `.getDataSource` (`DataSource`), `.getDeployMeta`; `maskCode` and `MASK` from `src/lib/mask-secrets.ts`; `stripCommentBlocks`, `commentStats` from `src/lib/strip-comments.ts`.
- Produces: `registerGetProcess(server, tm1Client)`. Tool `tm1_get_process` returns JSON `{ name, prolog?, metadata?, data?, epilog?, parameters?, variables?, dataSource?, hasSecurityAccess?, hint? }` — omitted parts absent.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/get-process.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerGetProcess } from "../../src/tools/ti-development/get-process.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function capture(processes: Partial<TM1Client["processes"]>): {
  cb: ToolCb;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {
    getCode: 0,
    getParameters: 0,
    getVariables: 0,
    getDataSource: 0,
    getDeployMeta: 0,
  };
  const counting = new Proxy(processes, {
    get(target, prop: string) {
      const orig = (target as Record<string, unknown>)[prop];
      if (typeof orig === "function") {
        return async (...args: unknown[]) => {
          if (prop in calls) calls[prop] += 1;
          return (orig as (...a: unknown[]) => unknown)(...args);
        };
      }
      return orig;
    },
  });
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerGetProcess(server, { processes: counting } as unknown as TM1Client);
  if (!cb) throw new Error("handler not registered");
  return { cb, calls };
}

const stubs = {
  getCode: async () => ({ prolog: "p", metadata: "m", data: "d", epilog: "e" }),
  getParameters: async () => [{ name: "pMonth", type: "String", defaultValue: "Jan" }],
  getVariables: async () => [{ name: "v1", type: "Numeric", position: 1 }],
  getDataSource: async () => ({ type: "None" }),
  getDeployMeta: async () => ({ hasSecurityAccess: true }),
};

describe("tm1_get_process", () => {
  it("returns all parts with upsert field names by default", async () => {
    const { cb } = capture(stubs);
    const payload = JSON.parse((await cb({ processName: "proc.a" }, {})).content[0].text);
    expect(payload).toMatchObject({
      name: "proc.a",
      prolog: "p",
      metadata: "m",
      data: "d",
      epilog: "e",
      parameters: [{ name: "pMonth" }],
      variables: [{ name: "v1" }],
      dataSource: { type: "None" },
      hasSecurityAccess: true,
    });
  });

  it("skips a part's service call when its include-flag is false", async () => {
    const { cb, calls } = capture(stubs);
    const payload = JSON.parse(
      (
        await cb(
          {
            processName: "proc.a",
            includeParameters: false,
            includeVariables: false,
            includeDataSource: false,
            includeSecurityAccess: false,
          },
          {},
        )
      ).content[0].text,
    );
    expect(payload.parameters).toBeUndefined();
    expect(payload.variables).toBeUndefined();
    expect(payload.dataSource).toBeUndefined();
    expect(payload.hasSecurityAccess).toBeUndefined();
    expect(payload.prolog).toBe("p");
    expect(calls.getParameters).toBe(0);
    expect(calls.getVariables).toBe(0);
    expect(calls.getDataSource).toBe(0);
    expect(calls.getDeployMeta).toBe(0);
    expect(calls.getCode).toBe(1);
  });

  it("masks datasource password when maskSecrets (default)", async () => {
    const { cb } = capture({
      ...stubs,
      getDataSource: async () => ({ type: "ODBC", password: "hunter2" }),
    });
    const payload = JSON.parse((await cb({ processName: "proc.a" }, {})).content[0].text);
    expect(payload.dataSource.password).toBe("***");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/get-process.test.ts`
Expected: FAIL — cannot import `registerGetProcess` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/ti-development/get-process.ts`:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { commentStats, stripCommentBlocks } from "../../lib/strip-comments.js";
import { maskCode, MASK } from "../../lib/mask-secrets.js";

const TABS = ["prolog", "metadata", "data", "epilog"] as const;
const HEAVY_MIN_LINES = 20;
const HEAVY_RATIO = 0.4;

export function registerGetProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process",
    "Native full read of a TI process — the read-twin of tm1_upsert_process. Returns the four code " +
      "tabs, parameters, variables, datasource and the HasSecurityAccess elevation flag in one call, " +
      "using the same field names as upsert_process for a clean round-trip. Every part is behind an " +
      "include-flag (all default true); set a flag false to skip that part's REST call. For git " +
      "persistence use tm1_export_process_to_git instead.",
    {
      processName: z.string().describe("Name of the TI process"),
      includeCode: z.boolean().optional().default(true).describe("Include the four code tabs (default true)."),
      includeParameters: z.boolean().optional().default(true).describe("Include parameters (default true)."),
      includeVariables: z.boolean().optional().default(true).describe("Include variables (default true)."),
      includeDataSource: z.boolean().optional().default(true).describe("Include the datasource config (default true)."),
      includeSecurityAccess: z.boolean().optional().default(true).describe("Include the HasSecurityAccess elevation flag (default true)."),
      maskSecrets: z.boolean().optional().default(true).describe(
        "Redact credential literals in code tabs and the datasource password. Default true; set false only when explicitly auditing credentials.",
      ),
      stripComments: z.boolean().optional().default(false).describe(
        "Collapse runs of 4+ comment lines in the code tabs into a marker (dead-code reduction). Default false.",
      ),
    },
    async ({
      processName,
      includeCode,
      includeParameters,
      includeVariables,
      includeDataSource,
      includeSecurityAccess,
      maskSecrets,
      stripComments,
    }) => {
      const payload: Record<string, unknown> = { name: processName };
      let hint: string | undefined;

      if (includeCode) {
        const code = await tm1Client.processes.getCode(processName);
        const tabs: Record<(typeof TABS)[number], string> = {
          prolog: code.prolog,
          metadata: code.metadata,
          data: code.data,
          epilog: code.epilog,
        };

        if (stripComments) {
          let removedLines = 0;
          let collapsedBlocks = 0;
          for (const tab of TABS) {
            const r = stripCommentBlocks(tabs[tab]);
            tabs[tab] = r.code;
            removedLines += r.removedLines;
            collapsedBlocks += r.collapsedBlocks;
          }
          if (collapsedBlocks > 0) {
            hint = `stripComments collapsed ${collapsedBlocks} comment block(s) (${removedLines} lines) into markers. ` +
              `Re-run without stripComments for the full source.`;
          }
        } else {
          let worst: { tab: string; total: number; comment: number; ratio: number } | undefined;
          for (const tab of TABS) {
            const s = commentStats(tabs[tab]);
            if (s.totalLines < HEAVY_MIN_LINES) continue;
            const ratio = s.commentLines / s.totalLines;
            if (ratio >= HEAVY_RATIO && (!worst || ratio > worst.ratio)) {
              worst = { tab, total: s.totalLines, comment: s.commentLines, ratio };
            }
          }
          if (worst) {
            const pct = Math.round(worst.ratio * 100);
            hint = `${worst.tab} tab is ${pct}% comments (${worst.comment}/${worst.total} lines). ` +
              `Set stripComments=true to collapse dead-code blocks and save context.`;
          }
        }

        if (maskSecrets) {
          for (const tab of TABS) tabs[tab] = maskCode(tabs[tab]);
        }
        Object.assign(payload, tabs);
      }

      if (includeParameters) {
        payload.parameters = await tm1Client.processes.getParameters(processName);
      }
      if (includeVariables) {
        payload.variables = await tm1Client.processes.getVariables(processName);
      }
      if (includeDataSource) {
        const ds = await tm1Client.processes.getDataSource(processName);
        if (maskSecrets && ds.password !== undefined && ds.password !== "") {
          ds.password = MASK;
        }
        payload.dataSource = ds;
      }
      if (includeSecurityAccess) {
        payload.hasSecurityAccess = (await tm1Client.processes.getDeployMeta(processName)).hasSecurityAccess;
      }
      if (hint) payload.hint = hint;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
```

- [ ] **Step 4: Wire the tool (registration + annotation)**

In `src/tools/index.ts`, add the import next to the other process-read imports (near line 29):

```ts
import { registerGetProcess } from "./ti-development/get-process.js";
```

And add to the `REGISTRARS` array next to `registerGetProcessCode` (near line 173):

```ts
  registerGetProcess,
```

In `src/tools/annotation-map.ts`, add next to the other process reads (near line 155):

```ts
  tm1_get_process: READ_ONLY,
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `npx vitest run tests/unit/get-process.test.ts && npm run typecheck`
Expected: PASS (all three cases) and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/ti-development/get-process.ts src/tools/index.ts src/tools/annotation-map.ts tests/unit/get-process.test.ts
git commit -m "feat(tools): add tm1_get_process native full read

Read-twin of tm1_upsert_process: one call returns code tabs, parameters,
variables, datasource and HasSecurityAccess with matching field names.
Include-flags gate each part's REST call; export_process_to_git stays
git-only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Live validation + README + full verify

**Files:**
- Modify: `tests/live/process.live.test.ts` (append cases)
- Modify: `README.md` (regenerated by script)
- Test: the live suite itself

**Interfaces:**
- Consumes: everything from Tasks 1–3 against a real TM1 server (env-configured, per existing live-test setup).

- [ ] **Step 1: Add live assertions**

Open `tests/live/process.live.test.ts`, follow the file's existing client-setup and process-fixture pattern, and append a `describe` that:

```ts
// Pseudocode shape — adapt names to the fixtures already defined in this file.
describe("HasSecurityAccess read paths (live)", () => {
  it("bulk getAllCode carries hasSecurityAccess", async () => {
    const rows = await client.processes.getAllCode(false);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(typeof r.hasSecurityAccess).toBe("boolean");
  });

  it("get_process parts + getDeployMeta return a boolean flag", async () => {
    const meta = await client.processes.getDeployMeta(EXISTING_PROCESS_NAME);
    expect(typeof meta.hasSecurityAccess).toBe("boolean");
    // Drive the tm1_get_process handler the way sibling live tests drive tools,
    // asserting parameters/variables/dataSource/hasSecurityAccess are present
    // with include-flags true, and absent when set false.
  });

  it("get_process_code opt-in surfaces hasSecurityAccess", async () => {
    const meta = await client.processes.getDeployMeta(EXISTING_PROCESS_NAME);
    expect(typeof meta.hasSecurityAccess).toBe("boolean");
  });
});
```

Use a process name already present in the live model (reuse whatever constant the existing live tests use — do NOT hardcode a customer/server name). If the model has a known elevated process, assert it `true`; otherwise assert the type only.

- [ ] **Step 2: Run the live suite**

Run: `npm run test:live -- -t "HasSecurityAccess read paths"`
Expected: PASS against the configured TM1 server.

- [ ] **Step 3: Regenerate the tool README**

Run: `npm run tools:update-readme`
Expected: `README.md` gains a `tm1_get_process` row; no other tools removed.

- [ ] **Step 4: Full verify**

Run: `npm run verify`
Expected: PASS — typecheck strict, lint:no-flat-api, lint:annotations, lint:tool-registration, all unit/property tests green.

- [ ] **Step 5: Commit**

```bash
git add tests/live/process.live.test.ts README.md
git commit -m "test(live): validate HasSecurityAccess read paths + refresh README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Change A (bulk flag) → Task 1. ✓
- Change B (`tm1_get_process`, include-flags, upsert field names, mask/strip, wiring, READ_ONLY) → Task 3. ✓
- Change C (`get_process_code` opt-in, default false) → Task 2. ✓
- Cross-cutting tests (unit + live), README, verify gate → Tasks 1–4. ✓
- Non-goals (getters untouched, export unchanged, no Caption) → respected; no task modifies them.

**Placeholder scan:** Task 4 Step 1 is intentionally shaped as "adapt to existing fixtures" because the live file's fixture names are environment-specific; every code-bearing step in Tasks 1–3 contains complete code. No TBD/TODO in shipped code.

**Type consistency:** `getAllCode` return type extended consistently (Task 1 ↔ Task 4). `getDeployMeta(): { hasSecurityAccess: boolean }` used identically in Tasks 2 and 3. `MASK = "***"` matches the datasource-mask assertion in Task 3 Step 1. Tool field names (`name/prolog/metadata/data/epilog/parameters/variables/dataSource/hasSecurityAccess/hint`) match `upsert_process` input names.
