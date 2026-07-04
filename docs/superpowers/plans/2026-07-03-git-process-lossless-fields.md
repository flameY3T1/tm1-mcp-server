# git-process Lossless Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tm1_export_process_to_git` / `tm1_import_process_from_git` round-trip carry every field TM1 exposes on the Process entity by adding `HasSecurityAccess` (functional) and `Attributes.Caption` (best-effort).

**Architecture:** Keep the readable two-file split (`{name}.json` + `{name}.ti`). Add two top-level keys to the `.json`. Export reads them via a new `ProcessService.getDeployMeta`; import writes `HasSecurityAccess` via a new `ProcessService.updateSecurityAccess` PATCH and Caption best-effort via the existing `ElementService.updateAttributeValue` against control cube `}ElementAttributes_}Processes`.

**Tech Stack:** TypeScript (strict), Zod, vitest, MCP SDK, TM1 OData v11.

## Global Constraints

- **Verify before done:** `npm run verify` (typecheck strict + lint:no-flat-api + lint:annotations + tests) must pass.
- **Service composition:** every new TM1 REST call lives on a service under `src/tm1-client/services/`, never on a flat client. Gate: `lint:no-flat-api`.
- **Strict output schemas:** any new handler output field MUST be added to the matching schema in `src/tools/schemas/items.ts` or the SDK rejects the payload (`additionalProperties:false`).
- **Secrets:** never serialize the ODBC `password` (already stripped); do not log raw creds.
- **Commits:** Conventional Commits; one logical change per commit; no real customer/server names in tests or docs.
- **Backward compatibility:** existing `.json` files lacking the new keys MUST parse to defaults (`hasSecurityAccess:false`, `caption` absent) — no breakage.

---

### Task 1: Serializer + parser carry hasSecurityAccess + caption

**Files:**
- Modify: `src/lib/git-process.ts` (interfaces `GitProcessInput` ~32-41 and `ParsedGitProcess` ~50-59; `serializeProcessToGit` ~86-96; `parseProcessFromGit` ~106-191)
- Test: `tests/unit/git-process-roundtrip.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `GitProcessInput` and `ParsedGitProcess` both gain `hasSecurityAccess: boolean;` and `caption?: string;`.
  - `serializeProcessToGit` writes `hasSecurityAccess` (always) and `caption` (only when truthy) into the `.json`.
  - `parseProcessFromGit` returns `hasSecurityAccess` (default `false`) and `caption` (optional).

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/git-process-roundtrip.test.ts`:

```ts
it("round-trips hasSecurityAccess=true", () => {
  const { parsed } = roundTrip(fixture({ hasSecurityAccess: true }));
  expect(parsed.hasSecurityAccess).toBe(true);
});

it("round-trips caption", () => {
  const { parsed } = roundTrip(fixture({ caption: "Load Actuals" }));
  expect(parsed.caption).toBe("Load Actuals");
});

it("defaults hasSecurityAccess to false and omits caption when absent", () => {
  const { json, parsed } = roundTrip(fixture());
  expect(parsed.hasSecurityAccess).toBe(false);
  expect(parsed.caption).toBeUndefined();
  expect(json).not.toContain("caption");
});

it("parses legacy JSON without the new keys to defaults", () => {
  const legacy = JSON.stringify({
    name: "Old", parameters: [], variables: [], dataSource: { type: "None" },
  });
  const ti = "### TM1-TI-TAB: prolog ###\n### TM1-TI-TAB: metadata ###\n" +
             "### TM1-TI-TAB: data ###\n### TM1-TI-TAB: epilog ###\n";
  const parsed = parseProcessFromGit(legacy, ti);
  expect(parsed.hasSecurityAccess).toBe(false);
  expect(parsed.caption).toBeUndefined();
});
```

Also update the `fixture()` helper's default to include `hasSecurityAccess: false` so `Partial<GitProcessInput>` typechecks after the interface gains a required field:

```ts
    dataSource: { type: "None" },
    hasSecurityAccess: false,
    ...over,
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/git-process-roundtrip.test.ts`
Expected: FAIL — `parsed.hasSecurityAccess` undefined / type error on `hasSecurityAccess` property.

- [ ] **Step 3: Add the fields to both interfaces**

In `src/lib/git-process.ts`, add to `GitProcessInput` (after `dataSource: DataSource;`) and to `ParsedGitProcess` (after `dataSource: DataSource;`):

```ts
  hasSecurityAccess: boolean;
  caption?: string;
```

- [ ] **Step 4: Write the fields in `serializeProcessToGit`**

Replace the `.json` object literal (currently `{ name, parameters, variables, dataSource: dataSourceNoPwd }`) with:

```ts
      {
        name: input.name,
        hasSecurityAccess: input.hasSecurityAccess,
        ...(input.caption ? { caption: input.caption } : {}),
        parameters: input.parameters,
        variables: input.variables,
        dataSource: dataSourceNoPwd,
      },
```

- [ ] **Step 5: Parse the fields in `parseProcessFromGit`**

Extend the `meta` type annotation to include the new optional keys:

```ts
  let meta: {
    name?: unknown;
    hasSecurityAccess?: unknown;
    caption?: unknown;
    parameters?: unknown;
    variables?: unknown;
    dataSource?: unknown;
  };
```

After the `const name = ...` line add:

```ts
  const hasSecurityAccess =
    typeof meta.hasSecurityAccess === "boolean" ? meta.hasSecurityAccess : false;
  const caption = typeof meta.caption === "string" && meta.caption.length > 0
    ? meta.caption
    : undefined;
```

Add both to the returned object (in the final `return { name, ... }` block):

```ts
    name,
    hasSecurityAccess,
    ...(caption !== undefined ? { caption } : {}),
    prolog: buckets.prolog.join("\n"),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/git-process-roundtrip.test.ts`
Expected: PASS (all cases, including legacy).

- [ ] **Step 7: Commit**

```bash
git add src/lib/git-process.ts tests/unit/git-process-roundtrip.test.ts
git commit -m "feat(git-process): serialize hasSecurityAccess + caption (lossless roundtrip)"
```

---

### Task 2: Export reads and emits the two fields

**Files:**
- Modify: `src/tm1-client/services/process-service.ts` (add `getDeployMeta` near `getCode` ~341)
- Modify: `src/tools/ti-development/export-process-to-git.ts` (`Promise.all` ~36-41; serializer call ~44-53; result JSON ~80-91)
- Modify: `src/tools/schemas/items.ts` (`ExportProcessToGitResultSchema` ~980-994)
- Test: `tests/unit/git-process-roundtrip.test.ts` already covers serialization; the REST read is covered live in Task 4.

**Interfaces:**
- Consumes: `serializeProcessToGit` from Task 1 (now accepting `hasSecurityAccess` + `caption`).
- Produces: `ProcessService.getDeployMeta(processName: string): Promise<{ hasSecurityAccess: boolean; caption?: string }>`.

- [ ] **Step 1: Add `getDeployMeta` to ProcessService**

In `src/tm1-client/services/process-service.ts`, after `getCode` (~356), add:

```ts
  /**
   * Read the deploy-relevant entity metadata not covered by getCode/params/
   * vars/datasource: HasSecurityAccess and the display Caption. Caption is
   * omitted when empty or equal to Name (TM1 defaults Caption to Name).
   * GET /api/v1/Processes('{name}')?$select=HasSecurityAccess,Attributes
   */
  async getDeployMeta(
    processName: string,
  ): Promise<{ hasSecurityAccess: boolean; caption?: string }> {
    const path =
      `/api/v1/Processes('${enc(processName)}')?$select=HasSecurityAccess,Attributes`;
    const response = await this.http.request<{
      HasSecurityAccess?: boolean;
      Attributes?: { Caption?: string };
    }>("GET", path);
    const caption = response.Attributes?.Caption;
    return {
      hasSecurityAccess: response.HasSecurityAccess === true,
      ...(caption && caption !== processName ? { caption } : {}),
    };
  }
```

- [ ] **Step 2: Wire it into the export handler**

In `src/tools/ti-development/export-process-to-git.ts`, extend the `Promise.all`:

```ts
      const [code, parameters, variables, dataSource, deployMeta] = await Promise.all([
        tm1Client.processes.getCode(processName),
        tm1Client.processes.getParameters(processName),
        tm1Client.processes.getVariables(processName),
        tm1Client.processes.getDataSource(processName),
        tm1Client.processes.getDeployMeta(processName),
      ]);
```

Pass the fields to the serializer (add after `epilog: mask(code.epilog),`):

```ts
        hasSecurityAccess: deployMeta.hasSecurityAccess,
        ...(deployMeta.caption ? { caption: deployMeta.caption } : {}),
```

Add to the result JSON object (after `dataSourceType: dataSource.type,`):

```ts
          hasSecurityAccess: deployMeta.hasSecurityAccess,
          ...(deployMeta.caption ? { caption: deployMeta.caption } : {}),
```

- [ ] **Step 3: Extend the output schema**

In `src/tools/schemas/items.ts`, add to `ExportProcessToGitResultSchema` (after `dataSourceType: z.string(),`):

```ts
  hasSecurityAccess: z.boolean(),
  caption: z.string().optional(),
```

- [ ] **Step 4: Verify typecheck + lint gates**

Run: `npm run verify`
Expected: PASS — no flat-api violation (call is on `processes` service), output schema matches handler.

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/services/process-service.ts src/tools/ti-development/export-process-to-git.ts src/tools/schemas/items.ts
git commit -m "feat(export-git): read + emit hasSecurityAccess and caption"
```

---

### Task 3: Import applies hasSecurityAccess (PATCH) + caption (best-effort)

**Files:**
- Modify: `src/tm1-client/services/process-service.ts` (add `updateSecurityAccess` near `updateCode` ~371)
- Modify: `src/tools/ti-development/import-process-from-git.ts` (apply block ~123-150; result JSON ~152-175)
- Modify: `src/tools/schemas/items.ts` (`ImportProcessFromGitResultSchema` ~551-563)

**Interfaces:**
- Consumes: `parseProcessFromGit` (now returns `hasSecurityAccess` + `caption`), `ProcessService.updateSecurityAccess`, `ElementService.updateAttributeValue(dimensionName, elementName, attributeName, value)` (existing).
- Produces: `ProcessService.updateSecurityAccess(processName: string, hasSecurityAccess: boolean): Promise<void>`.

- [ ] **Step 1: Add `updateSecurityAccess` to ProcessService**

In `src/tm1-client/services/process-service.ts`, after `updateCode` (~371), add:

```ts
  /**
   * Set the HasSecurityAccess flag on a process.
   * PATCH /api/v1/Processes('{name}') with { HasSecurityAccess }.
   */
  async updateSecurityAccess(
    processName: string,
    hasSecurityAccess: boolean,
  ): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    await this.http.request<void>("PATCH", path, { HasSecurityAccess: hasSecurityAccess });
  }
```

- [ ] **Step 2: Apply both in the import handler**

In `src/tools/ti-development/import-process-from-git.ts`, after the datasource block (~150, before the `return`), add:

```ts
      await withToolHint(
        tm1Client.processes.updateSecurityAccess(processName, parsed.hasSecurityAccess),
        `HasSecurityAccess update failed for '${processName}'. Code+params+vars+datasource applied. Re-run with mode=update once resolved.`,
      );

      // Caption is a display alias stored on the }ElementAttributes_}Processes
      // control cube. Best-effort: a non-admin import (or a locked control cube)
      // must not fail the whole deploy — surface the outcome via captionApplied.
      let captionApplied = false;
      if (parsed.caption) {
        try {
          await tm1Client.elements.updateAttributeValue(
            "}Processes", processName, "Caption", parsed.caption,
          );
          captionApplied = true;
        } catch {
          captionApplied = false;
        }
      }
```

- [ ] **Step 3: Surface both in the result JSON**

In the same file, add them at the top level of the result object, after `processName,`:

```ts
                action,
                processName,
                hasSecurityAccess: parsed.hasSecurityAccess,
                captionApplied,
                parsed: {
```

- [ ] **Step 4: Extend the output schema**

In `src/tools/schemas/items.ts`, add to `ImportProcessFromGitResultSchema` (after `processName: z.string(),`):

```ts
  hasSecurityAccess: z.boolean(),
  captionApplied: z.boolean(),
```

- [ ] **Step 5: Verify typecheck + lint gates**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tm1-client/services/process-service.ts src/tools/ti-development/import-process-from-git.ts src/tools/schemas/items.ts
git commit -m "feat(import-git): apply hasSecurityAccess (PATCH) + caption (best-effort)"
```

---

### Task 4: Live roundtrip validation

**Files:**
- Modify: `tests/live/process.live.test.ts` (add one test inside the existing `describe.skipIf(!LIVE_ENABLED)` block; reuse `getHarness`, `SANDBOX`)

**Interfaces:**
- Consumes: the harness `h.call(name, args)` MCP surface; tools `tm1_upsert_process`, `tm1_export_process_to_git`, `tm1_import_process_from_git`, `tm1_delete_process`.

- [ ] **Step 1: Write the live test**

Add to `tests/live/process.live.test.ts`. Before writing, confirm the `tm1_upsert_process` input schema accepts `hasSecurityAccess`; if it does not, see Step 2's fallback.

```ts
it("git export->import preserves hasSecurityAccess", async () => {
  const src = `${SANDBOX}_GIT_SEC_SRC`;
  const dst = `${SANDBOX}_GIT_SEC_DST`;
  try {
    // Create a source process with elevated security access.
    await h.call("tm1_upsert_process", {
      processName: src,
      prolog: "# harmless\nnX = 1;",
      hasSecurityAccess: true,
    });

    const exp = await h.call("tm1_export_process_to_git", { processName: src });
    const out = JSON.parse(exp.result.content[0].text as string);
    expect(out.hasSecurityAccess).toBe(true);

    // Import into a second name; assert the flag survived.
    const imp = await h.call("tm1_import_process_from_git", {
      jsonContent: out.json.replace(`"name": "${src}"`, `"name": "${dst}"`),
      tiContent: out.ti,
      mode: "upsert",
    });
    const impOut = JSON.parse(imp.result.content[0].text as string);
    expect(impOut.hasSecurityAccess).toBe(true);

    const meta = await h.call("tm1_export_process_to_git", { processName: dst });
    expect(JSON.parse(meta.result.content[0].text as string).hasSecurityAccess).toBe(true);
  } finally {
    for (const n of [src, dst]) {
      await h.call("tm1_delete_process", { processName: n, confirm: n }).catch(() => {});
    }
  }
});
```

- [ ] **Step 2: Run the live test (requires TM1_BASE_URL + TM1_USER in .env)**

Run: `npx vitest run -c vitest.live.config.ts tests/live/process.live.test.ts -t "hasSecurityAccess"`
Expected: PASS. If `tm1_upsert_process` does not accept `hasSecurityAccess`, seed the flag directly instead: after the upsert, add `await h.call("tm1_upsert_process", { processName: src, mode: "update" });` is not sufficient — instead call the service through the harness client (`getHarness` exposes the tool layer only), so extend `tm1_upsert_process` minimally per the "Known follow-up" section, or set the flag inside the test via a second import. Prefer extending `tm1_upsert_process`.

- [ ] **Step 3: Validate the Caption write path live (spike)**

Via a throwaway harness call, import a JSON containing `"caption": "Roundtrip Alias"` and assert the result's `captionApplied`. If TM1 accepts the control-cube write, expect `captionApplied:true` and a re-export showing the caption. If TM1 rejects it (non-admin / locked control cube), expect `captionApplied:false` AND the import still succeeding. Then edit `docs/superpowers/specs/2026-07-03-git-process-lossless-fields-design.md` Risks section: replace "write path unverified" with the confirmed result.

- [ ] **Step 4: Full verify + README regen**

Run: `npm run verify`
Expected: PASS (unit + gates). Tool result shapes changed but descriptions did not; run README regen only if any tool description text changed:
Run: `npm run tools:update-readme`

- [ ] **Step 5: Commit**

```bash
git add tests/live/process.live.test.ts docs/superpowers/specs/2026-07-03-git-process-lossless-fields-design.md
git commit -m "test(live): verify git roundtrip preserves hasSecurityAccess + caption"
```

---

## Self-Review

- **Spec coverage:** Export read (Task 2), serializer (Task 1), parser + backward-compat (Task 1), import apply HasSecurityAccess + best-effort Caption (Task 3), output surface + schemas (Tasks 2/3), unit + live tests (Tasks 1/4), Caption write-path validation (Task 4 Step 3). All spec sections mapped.
- **Placeholder scan:** every code step shows concrete code; no TBD/TODO.
- **Type consistency:** `getDeployMeta` returns `{hasSecurityAccess, caption?}` (Task 2) consumed by the export handler; `updateSecurityAccess(name, bool)` (Task 3) matches its call site; `parseProcessFromGit` returns `hasSecurityAccess`+`caption?` (Task 1) consumed in Task 3; `ElementService.updateAttributeValue(dim, el, attr, value)` matches the existing signature.

## Known follow-up
- `tm1_upsert_process` may not yet expose `hasSecurityAccess` as an input. If Task 4 reveals this, extend that tool minimally (input field + pass to `processes.updateSecurityAccess`) — it is the natural authoring counterpart to the git roundtrip and keeps the surface consistent.
