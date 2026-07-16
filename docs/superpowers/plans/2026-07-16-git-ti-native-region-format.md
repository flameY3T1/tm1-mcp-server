# Git TI Native `#region` Format — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tm1_export_process_to_git` / `tm1_import_process_from_git` use TM1's native `#region <Tab>` / `#endregion` code representation (the `Code` property) instead of our home-grown `### TM1-TI-TAB:` markers.

**Architecture:** Export sources the `.ti` blob directly from `GET /Processes('x')/Code/$value` (server owns the marker syntax). Import writes it back via `PATCH /Processes('x') {Code: blob}` (server splits regions into the four procedures — a full replace that clears omitted tabs). The `.json` sibling (params/vars/datasource/hasSecurityAccess) is unchanged. Our only local `#region` handling is a parser used for import preflight.

**Tech Stack:** TypeScript, Node, vitest, MCP SDK, TM1 REST (OData v1).

## Global Constraints

- Verify gate: `npm run verify` must pass (typecheck strict + lints + tests). CI runs the same.
- New TM1 REST calls go in a service under `src/tm1-client/services/` (never a flat client). Gate: `lint:no-flat-api`.
- No new tool → no annotation/schema changes. Do not touch `get_process`, `get_process_code`, `get_all_processes_code` (stay on `$select`).
- Conventional Commits; one logical change per commit; no real customer/server names in tests/docs.
- Newlines: `.ti` is CRLF everywhere (file + wire), byte-identical to `GET /Code/$value`.
- Back-compat: **hard-cut** — pre-1.x `### TM1-TI-TAB:` files must be rejected on import.

**Reference spec:** `docs/superpowers/specs/2026-07-16-git-ti-native-region-format-design.md`

**Verified server facts (live, tm1-test 11.x):**
- `GET .../Code/$value` → `text/plain`, blob: `#region Prolog\r\n<code>\r\n#endregion` (lowercase keyword, Capitalized tab, empty tabs omitted, CRLF, no trailing newline).
- `PATCH .../Processes('x') {Code: blob}` → 200; server splits regions AND **clears** tabs whose region is absent (full replace).
- `PUT .../Code/$value` and `PUT .../<Tab>Procedure/$value` → 400 (`$value` is read-only).

---

## Task 1: Transport methods (`getCodeBlob`, `updateCodeBlob`)

**Files:**
- Modify: `src/tm1-client/services/process-service.ts` (add two methods next to `getCode`/`updateCode`, ~line 368/398)
- Test: `tests/unit/tm1-client-process.test.ts`

**Interfaces:**
- Consumes: `this.http.requestRaw(method, path, opts?): Promise<string>` (http.ts:207, raw text, re-auths on 401); `this.http.request<void>(method, path, body?)` (http.ts:92); `enc(name)` (existing OData-key encoder in this file).
- Produces:
  - `getCodeBlob(processName: string): Promise<string>` — raw `#region` blob from `GET .../Code/$value`.
  - `updateCodeBlob(processName: string, blob: string): Promise<void>` — `PATCH .../Processes('x')` with `{ Code: blob }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/tm1-client-process.test.ts` inside the existing `describe` (reuse its `fetchSpy`, `client`, `mockResponse`, `mock204Response` helpers):

```ts
it("getCodeBlob GETs Code/$value and returns raw text", async () => {
  const blob = "#region Prolog\r\nsX=1;\r\n#endregion";
  fetchSpy.mockResolvedValueOnce({
    ok: true, status: 200, statusText: "OK",
    headers: new Headers({ "content-type": "text/plain" }),
    text: vi.fn().mockResolvedValue(blob),
    json: vi.fn().mockRejectedValue(new Error("not json")),
  } as unknown as Response);

  const result = await client.processes.getCodeBlob("My.Proc");

  expect(result).toBe(blob);
  const calledUrl = fetchSpy.mock.calls[0][0] as string;
  expect(calledUrl).toContain("/Processes('My.Proc')/Code/$value");
});

it("updateCodeBlob PATCHes { Code } to the process entity", async () => {
  fetchSpy.mockResolvedValueOnce(mock204Response());
  const blob = "#region Prolog\r\nsX=1;\r\n#endregion";

  await client.processes.updateCodeBlob("My.Proc", blob);

  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
  expect(url).toContain("/Processes('My.Proc')");
  expect((init.method as string).toUpperCase()).toBe("PATCH");
  expect(JSON.parse(init.body as string)).toEqual({ Code: blob });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/unit/tm1-client-process.test.ts -t "Code"`
Expected: FAIL — `getCodeBlob`/`updateCodeBlob` not a function.

- [ ] **Step 3: Implement the two methods**

In `src/tm1-client/services/process-service.ts`, immediately after `updateCode` (ends ~line 398):

```ts
  /**
   * Read the whole process code as TM1's native `#region <Tab>` / `#endregion`
   * blob. GET /api/v1/Processes('{name}')/Code/$value (text/plain). Empty tabs
   * are omitted by the server; newlines are CRLF.
   */
  async getCodeBlob(processName: string): Promise<string> {
    const path = `/api/v1/Processes('${enc(processName)}')/Code/$value`;
    return this.http.requestRaw("GET", path);
  }

  /**
   * Write the whole process code from a native `#region` blob. PATCH
   * /api/v1/Processes('{name}') { Code }. The server parses the region markers
   * and does a FULL replace of all four tabs — tabs whose region is absent are
   * cleared. `$value` PUT is not supported by TM1, so this JSON PATCH is the
   * only write path.
   */
  async updateCodeBlob(processName: string, blob: string): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    await this.http.request<void>("PATCH", path, { Code: blob });
  }
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/unit/tm1-client-process.test.ts -t "Code"`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/services/process-service.ts tests/unit/tm1-client-process.test.ts
git commit -m "feat(process-service): add getCodeBlob/updateCodeBlob via native Code property"
```

---

## Task 2: `git-process.ts` — `#region` parser + json-only serialize

**Files:**
- Modify: `src/lib/git-process.ts` (rewrite)
- Test: `tests/unit/git-process-roundtrip.test.ts` (rewrite)

**Interfaces:**
- Consumes: `parameterSchema`, `variableSchema`, `dataSourceSchema` from `./process-parts-schema.js`; types `DataSource`, `ProcessParameter`, `ProcessVariable` from `../types.js`.
- Produces:
  - `GitProcessInput` = `{ name; parameters: ProcessParameter[]; variables: ProcessVariable[]; dataSource: DataSource; hasSecurityAccess: boolean }` (code fields removed).
  - `serializeProcessToGit(input: GitProcessInput): { json: string; credentialsOmitted: boolean }` (no longer returns `ti`).
  - `parseProcessFromGit(jsonContent: string, tiContent: string): ParsedGitProcess` — parses `#region` blob; throws if no region markers.
  - `ParsedGitProcess` unchanged in shape (`name, prolog, metadata, data, epilog, parameters, variables, dataSource, hasSecurityAccess?`).

- [ ] **Step 1: Rewrite the unit test file**

Replace the entire contents of `tests/unit/git-process-roundtrip.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  serializeProcessToGit,
  parseProcessFromGit,
  type GitProcessInput,
} from "../../src/lib/git-process.js";
import type { DataSource } from "../../src/types.js";

function fixture(over: Partial<GitProcessInput> = {}): GitProcessInput {
  return {
    name: "MyProc",
    parameters: [
      { name: "pNum", type: "Numeric", defaultValue: 42, prompt: "a number" },
      { name: "pStr", type: "String", defaultValue: "default", prompt: "a string" },
    ],
    variables: [
      { name: "vCol1", type: "String", position: 1 },
      { name: "vCol2", type: "Numeric", position: 2 },
    ],
    dataSource: { type: "None" },
    hasSecurityAccess: false,
    ...over,
  };
}

/** Build a native #region blob the way the TM1 server emits it (CRLF,
 *  empty tabs omitted). Tab keys are Capitalized. */
function makeTi(tabs: Partial<Record<"Prolog" | "Metadata" | "Data" | "Epilog", string>>): string {
  return (["Prolog", "Metadata", "Data", "Epilog"] as const)
    .filter((k) => tabs[k] && tabs[k]!.length > 0)
    .map((k) => `#region ${k}\r\n${tabs[k]}\r\n#endregion`)
    .join("\r\n");
}

describe("git-process #region round-trip", () => {
  it("serializes json in OData-native field order (top-level + param fields)", () => {
    const { json } = serializeProcessToGit({
      name: "P",
      parameters: [{ name: "pA", type: "Numeric", defaultValue: 1, prompt: "ask" }],
      variables: [],
      dataSource: { type: "None" },
      hasSecurityAccess: true,
    });
    expect(json).toBe(
      `{
  "name": "P",
  "hasSecurityAccess": true,
  "dataSource": {
    "type": "None"
  },
  "parameters": [
    {
      "name": "pA",
      "prompt": "ask",
      "value": 1,
      "type": "Numeric"
    }
  ],
  "variables": []
}
`,
    );
  });

  it("parses #region tabs into prolog/metadata/data/epilog; omitted tab is empty", () => {
    const ti = makeTi({ Prolog: "sP='p';", Data: "sD='d';", Epilog: "sE='e';" });
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe("sP='p';");
    expect(parsed.metadata).toBe("");
    expect(parsed.data).toBe("sD='d';");
    expect(parsed.epilog).toBe("sE='e';");
  });

  it("parses #region case-insensitively (lowercase tab name)", () => {
    const ti = "#region prolog\r\nsP='p';\r\n#endregion";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(parseProcessFromGit(json, ti).prolog).toBe("sP='p';");
  });

  it("rejects a .ti with no #region markers (hard-cut)", () => {
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, "just some text\nno markers")).toThrow(/#region/);
  });

  it("rejects the pre-1.x ### TM1-TI-TAB: layout (hard-cut)", () => {
    const legacy = "### TM1-TI-TAB: prolog ###\n### TM1-TI-TAB: metadata ###\n";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, legacy)).toThrow(/#region/);
  });

  it("parses git param 'value' (native) into internal defaultValue", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P", hasSecurityAccess: false, dataSource: { type: "None" },
      parameters: [{ name: "pA", prompt: "ask", value: 7, type: "Numeric" }], variables: [],
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({ name: "pA", defaultValue: 7, type: "Numeric" });
  });

  it("still parses legacy 'defaultValue' git files (param back-compat)", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P", parameters: [{ name: "pA", type: "String", defaultValue: "x" }],
      variables: [], dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({ name: "pA", defaultValue: "x", type: "String" });
  });

  it("parameters/variables/dataSource survive from json", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const { json } = serializeProcessToGit(fixture());
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.parameters.find((p) => p.name === "pNum")).toMatchObject({ type: "Numeric", defaultValue: 42, prompt: "a number" });
    expect(parsed.variables.find((v) => v.name === "vCol1")).toMatchObject({ type: "String", position: 1 });
    expect(parsed.dataSource).toMatchObject({ type: "None" });
  });

  it("ODBC password is stripped from JSON and flagged", () => {
    const ds: DataSource = { type: "ODBC", dataSourceNameForServer: "MyDSN", userName: "etl_user", password: "s3cr3t", query: "SELECT 1" };
    const serialized = serializeProcessToGit(fixture({ dataSource: ds }));
    expect(serialized.credentialsOmitted).toBe(true);
    expect(serialized.json).not.toContain("s3cr3t");
    expect(serialized.json).toContain("etl_user");
    const parsed = parseProcessFromGit(serialized.json, makeTi({ Prolog: "x=1;" }));
    expect(parsed.dataSource.password).toBeUndefined();
  });

  it("no password => credentialsOmitted false", () => {
    expect(serializeProcessToGit(fixture()).credentialsOmitted).toBe(false);
  });

  it("json ends with a trailing newline", () => {
    expect(serializeProcessToGit(fixture()).json.endsWith("\n")).toBe(true);
  });

  it("invalid JSON is rejected", () => {
    expect(() => parseProcessFromGit("{not json", makeTi({ Prolog: "x=1;" }))).toThrow(/not valid JSON/);
  });

  it("rejects a parameter with an invalid type instead of blind-casting it", () => {
    const meta = { name: "P", parameters: [{ name: "pMonth", type: "bad", defaultValue: "1" }], variables: [], dataSource: { type: "None" } };
    expect(() => parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" }))).toThrow(/invalid 'parameters'/);
  });

  it("rejects a non-array variables field", () => {
    const meta = { name: "P", parameters: [], variables: { not: "an array" }, dataSource: { type: "None" } };
    expect(() => parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" }))).toThrow(/invalid 'variables'/);
  });

  it("round-trips hasSecurityAccess=true", () => {
    const { json } = serializeProcessToGit(fixture({ hasSecurityAccess: true }));
    expect(parseProcessFromGit(json, makeTi({ Prolog: "x=1;" })).hasSecurityAccess).toBe(true);
  });

  it("parses legacy JSON without hasSecurityAccess to undefined", () => {
    const legacy = JSON.stringify({ name: "Old", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(parseProcessFromGit(legacy, makeTi({ Prolog: "x=1;" })).hasSecurityAccess).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/unit/git-process-roundtrip.test.ts`
Expected: FAIL (old `serializeProcessToGit` still returns `ti`; `GitProcessInput` still requires code fields; parser still expects `### TM1-TI-TAB:`).

- [ ] **Step 3: Rewrite `src/lib/git-process.ts`**

Replace the whole file with:

```ts
import { z } from "zod";
import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../types.js";
import {
  parameterSchema,
  variableSchema,
  dataSourceSchema,
} from "./process-parts-schema.js";

/**
 * tm1-git two-file representation of a TI process.
 *
 * `{name}.json` holds the structure (parameters, variables, datasource,
 * hasSecurityAccess). `{name}.ti` holds the code as TM1's native `Code`
 * representation — `#region <Tab>` / `#endregion` blocks (CRLF, empty tabs
 * omitted), byte-identical to `GET /Processes('x')/Code/$value`. The `.ti`
 * blob is produced by the server, not built here; this module only parses it
 * back (for import preflight). The `.json` is built by serializeProcessToGit.
 *
 * Credentials: the ODBC `password` is never written to the .json. A committed
 * password would be a leaked secret; on import it is re-supplied out of band
 * (see `dataSourcePassword` on the import tool).
 */

export interface GitProcessInput {
  name: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
  hasSecurityAccess: boolean;
}

export interface GitProcessJson {
  json: string;
  /** True when an ODBC password was present and stripped from the JSON. */
  credentialsOmitted: boolean;
}

export interface ParsedGitProcess {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
  hasSecurityAccess?: boolean;
}

const TAB_ORDER = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TAB_ORDER)[number];

/**
 * Build only the `{name}.json` (structure). Field order mirrors TM1's OData
 * Process entity (Name, HasSecurityAccess, DataSource, then Parameters/
 * Variables); parameter objects follow OData order (Name, Prompt, Value, Type).
 * Order is cosmetic — parseProcessFromGit reads by key.
 */
export function serializeProcessToGit(input: GitProcessInput): GitProcessJson {
  const { password, ...dataSourceNoPwd } = input.dataSource;
  const credentialsOmitted = password !== undefined && password !== "";

  const json =
    JSON.stringify(
      {
        name: input.name,
        hasSecurityAccess: input.hasSecurityAccess,
        dataSource: dataSourceNoPwd,
        parameters: input.parameters.map((p) => ({
          name: p.name,
          ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
          value: p.defaultValue,
          type: p.type,
        })),
        variables: input.variables,
      },
      null,
      2,
    ) + "\n";

  return { json, credentialsOmitted };
}

/**
 * Parse a native `#region <Tab>` / `#endregion` code blob into the four tabs.
 * Case-insensitive on keyword and tab name; a tab whose region is absent
 * defaults to "". Throws if the blob has no region markers at all (rejects the
 * pre-1.x `### TM1-TI-TAB:` layout — no longer supported).
 */
function parseCodeBlob(ti: string): Record<Tab, string> {
  const out: Record<Tab, string> = { prolog: "", metadata: "", data: "", epilog: "" };
  const re =
    /^[ \t]*#region[ \t]+(prolog|metadata|data|epilog)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*#endregion\b[^\r\n]*$/gim;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = re.exec(ti)) !== null) {
    const tab = m[1].toLowerCase() as Tab;
    // Strip the single newline the server places before #endregion.
    out[tab] = m[2].replace(/\r?\n$/, "");
    found++;
  }
  if (found === 0) {
    throw new Error(
      "TI file has no #region markers (expected `#region Prolog` … `#endregion`). " +
        "Pre-1.x `### TM1-TI-TAB:` files are no longer supported — re-export from the server.",
    );
  }
  return out;
}

/** Parse a `{name}.json` + `{name}.ti` pair back into deployable process parts. */
export function parseProcessFromGit(
  jsonContent: string,
  tiContent: string,
): ParsedGitProcess {
  let meta: {
    name?: unknown;
    hasSecurityAccess?: unknown;
    parameters?: unknown;
    variables?: unknown;
    dataSource?: unknown;
  };
  try {
    meta = JSON.parse(jsonContent) as typeof meta;
  } catch {
    throw new Error("Process JSON is not valid JSON");
  }

  const name = typeof meta.name === "string" ? meta.name : "";
  const hasSecurityAccess =
    typeof meta.hasSecurityAccess === "boolean" ? meta.hasSecurityAccess : undefined;

  // Git .json uses the OData-native param field name `value`; the internal
  // schema uses `defaultValue`. Normalize value→defaultValue before validation,
  // keeping back-compat with legacy files that wrote `defaultValue`.
  const rawParams = Array.isArray(meta.parameters)
    ? meta.parameters.map((p) => {
        if (p && typeof p === "object" && "value" in p && !("defaultValue" in p)) {
          const { value, ...rest } = p as Record<string, unknown>;
          return { ...rest, defaultValue: value };
        }
        return p;
      })
    : (meta.parameters ?? []);

  const paramsResult = z.array(parameterSchema).safeParse(rawParams);
  if (!paramsResult.success) {
    throw new Error(
      `Process JSON has invalid 'parameters': ${paramsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const parameters: ProcessParameter[] = paramsResult.data;

  const varsResult = z.array(variableSchema).safeParse(meta.variables ?? []);
  if (!varsResult.success) {
    throw new Error(
      `Process JSON has invalid 'variables': ${varsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const variables: ProcessVariable[] = varsResult.data;

  const dsResult = dataSourceSchema.safeParse(meta.dataSource ?? { type: "None" });
  if (!dsResult.success) {
    throw new Error(
      `Process JSON has invalid 'dataSource': ${dsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const dataSource: DataSource = dsResult.data;

  const tabs = parseCodeBlob(tiContent);

  return {
    name,
    ...(hasSecurityAccess !== undefined ? { hasSecurityAccess } : {}),
    prolog: tabs.prolog,
    metadata: tabs.metadata,
    data: tabs.data,
    epilog: tabs.epilog,
    parameters,
    variables,
    dataSource,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/unit/git-process-roundtrip.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/git-process.ts tests/unit/git-process-roundtrip.test.ts
git commit -m "feat(git-process): parse native #region code blob; serialize json only"
```

---

## Task 3: Export tool — source `.ti` from the server blob

**Files:**
- Modify: `src/tools/ti-development/export-process-to-git.ts:16` (description) and `:36-55` (fetch + serialize)

**Interfaces:**
- Consumes: `tm1Client.processes.getCodeBlob` (Task 1); `serializeProcessToGit` returning `{ json, credentialsOmitted }` (Task 2); existing `maskCode`, `maskDataSourceSecrets`.
- Produces: unchanged tool output shape (`json`, `ti`, filenames, counts, `credentialsOmitted`, `writtenTo`).

- [ ] **Step 1: Replace the fetch + serialize block**

In `src/tools/ti-development/export-process-to-git.ts`, replace lines 36–55 (`const [code, …]` through the `serializeProcessToGit({ … })` call) with:

```ts
      const [codeBlob, parameters, variables, dataSource, deployMeta] = await Promise.all([
        tm1Client.processes.getCodeBlob(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariables(processName),
        tm1Client.processes.getDataSource(processName),
        tm1Client.processes.getDeployMeta(processName),
      ]);

      const mask = maskSecrets ? maskCode : (s: string) => s;
      const ti = mask(codeBlob);
      const { json, credentialsOmitted } = serializeProcessToGit({
        name: processName,
        parameters,
        variables,
        dataSource: maskSecrets ? maskDataSourceSecrets(dataSource) : dataSource,
        hasSecurityAccess: deployMeta.hasSecurityAccess,
      });
```

- [ ] **Step 2: Fix the tool description**

In the same file, replace the description line (currently line 16):

```ts
      "This diff-friendly format TM1's native Git integration TM1py use — code lives outside JSON so Git diffs stay readable.",
```

with:

```ts
      "The .ti holds the code in TM1's native `Code` representation (#region <Tab> / #endregion, CRLF, empty tabs omitted); the .json holds the structure. Code lives outside the JSON so Git diffs stay readable.",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`ti` is still defined for the write/response block below; the `code` variable is gone and no longer referenced.)

- [ ] **Step 4: Commit**

```bash
git add src/tools/ti-development/export-process-to-git.ts
git commit -m "feat(export-git): source .ti from native Code blob; fix format description"
```

---

## Task 4: Import tool — write via `updateCodeBlob`

**Files:**
- Modify: `src/tools/ti-development/import-process-from-git.ts:123-131` (code write)

**Interfaces:**
- Consumes: `tm1Client.processes.updateCodeBlob` (Task 1); existing `ti` variable (raw blob resolved from `tiContent`/`tiPath`); `parseProcessFromGit` (Task 2, used for preflight).
- Produces: unchanged tool output.

- [ ] **Step 1: Replace the code-write call**

In `src/tools/ti-development/import-process-from-git.ts`, replace lines 123–131 (the `updateCode(processName, { prolog, … })` `withToolHint` block) with:

```ts
      // Write code via TM1's native Code property: send the raw #region blob
      // (normalized to CRLF, as TM1 emits/expects) and let the server split it
      // into the four tabs. This is a full replace — tabs whose region is
      // absent are cleared, matching the exported .ti exactly.
      await withToolHint(
        tm1Client.processes.updateCodeBlob(processName, ti.replace(/\r?\n/g, "\r\n")),
        `Code update failed after process '${processName}' was ${exists ? "located" : "created"}. PARTIAL APPLY: shell exists but tabs are stale/empty. Re-run with mode=update once root cause fixed, or tm1_delete_process to roll back.`,
      );
```

(The `ti` variable already holds the raw file body; `parsed` is still used above for the preflight `check()`, so no other change is needed.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tools/ti-development/import-process-from-git.ts
git commit -m "feat(import-git): deploy code via native PATCH {Code} blob"
```

---

## Task 5: Live round-trip test + CHANGELOG

**Files:**
- Modify: `tests/live/process.live.test.ts` (add a native round-trip case)
- Modify: `CHANGELOG.md` (BREAKING entry under `[Unreleased]`)

**Interfaces:**
- Consumes: the live TM1 test server (env-driven, same as the rest of `process.live.test.ts`); the export/import methods end-to-end.

- [ ] **Step 1: Add a live round-trip test**

Open `tests/live/process.live.test.ts`, mirror its existing setup (client construction, a disposable process name prefixed like the other live fixtures, cleanup in `afterAll`/`finally`). Add:

```ts
it("git export → import round-trips code via native #region blob", async () => {
  const name = `zzTest_git_native_${Date.now()}`;
  try {
    // seed a process with 3 non-empty tabs (metadata intentionally empty)
    await client.processes.create(name);
    await client.processes.updateCodeBlob(
      name,
      "#region Prolog\r\nsP='p';\r\n#endregion\r\n#region Data\r\nsD='d';\r\n#endregion\r\n#region Epilog\r\nsE='e';\r\n#endregion",
    );

    // export blob: non-empty tabs present, empty tab omitted
    const blob = await client.processes.getCodeBlob(name);
    expect(blob).toContain("#region Prolog");
    expect(blob).not.toContain("#region Metadata"); // empty tab omitted

    // re-import the same blob → tabs match, metadata cleared (full replace)
    await client.processes.updateCodeBlob(name, blob);
    const code = await client.processes.getCode(name);
    expect(code.prolog).toContain("sP='p';");
    expect(code.data).toContain("sD='d';");
    expect(code.epilog).toContain("sE='e';");
    expect(code.metadata).toBe("");
  } finally {
    await client.processes.delete(name).catch(() => {});
  }
});
```

(If the live suite exposes shared create/delete helpers or a shared `client`, use those and match the file's existing pattern. Confirm the delete method name in `process-service.ts` — the file uses `delete`; adjust if the live suite wraps it.)

- [ ] **Step 2: Run the live test** (requires a reachable TM1 test server)

Run: `npx vitest run --config vitest.live.config.ts tests/live/process.live.test.ts -t "native #region"`
Expected: PASS. If the server is unreachable, report it and defer to the live env — do not skip silently.

- [ ] **Step 3: Add the BREAKING CHANGELOG entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add (create a `### Changed` subsection if absent):

```markdown
### Changed
- **BREAKING:** `tm1_export_process_to_git` / `tm1_import_process_from_git` now use
  TM1's native `#region <Tab>` / `#endregion` code format (the server `Code`
  property) instead of the previous `### TM1-TI-TAB:` markers. Exported `.ti`
  files are byte-identical to `GET /Processes('x')/Code/$value` (CRLF, empty
  tabs omitted). `.ti` files produced by earlier versions are no longer
  importable — re-export from the server to regenerate.
```

- [ ] **Step 4: Run full verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/live/process.live.test.ts CHANGELOG.md
git commit -m "test(git-native): live round-trip; docs: BREAKING changelog for #region format"
```

---

## Self-review notes

- **Spec coverage:** transport (T1), format+parser (T2), export (T3), import (T4), tests+migration+description-fix (T3/T5). Empty-tab clearing already verified (spec item 1) and exercised by T5. Version-availability (spec item 2): v11 baseline confirmed — surfaced by T5 against the live server, no separate task.
- **Type consistency:** `getCodeBlob`/`updateCodeBlob` signatures identical across T1/T3/T4; `serializeProcessToGit` returns `{ json, credentialsOmitted }` everywhere (T2/T3); `GitProcessInput` code fields removed in T2 and no caller passes them (T3 updated).
- **`get_process*` untouched** — confirmed out of scope; still on `$select`.
- **Unchanged behavior noted:** a hand-edited `.ti` using LF is normalized to CRLF on import (T4); export emits whatever the server returns.
