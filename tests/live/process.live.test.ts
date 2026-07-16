// Live PROCESS (TI development) tier: exercises the TurboIntegrator tool
// surface end-to-end against the running TM1 server. Every object it creates
// is prefixed `${SANDBOX}_PROC` and torn down in afterAll, so a stray run can
// never touch real model objects. All TI is deliberately harmless — no data
// sources touching real cubes, no CubeClearData; just parameter/variable
// assignment so compile + execute are guaranteed safe.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const PROC_A = `${SANDBOX}_PROC_A`;
const PROC_B = `${SANDBOX}_PROC_B`;
const PROC_BAD = `${SANDBOX}_PROC_BAD`;
const PROC_GIT_SRC = `${SANDBOX}_PROC_GIT_SRC`;
const PROC_GIT_DST = `${SANDBOX}_PROC_GIT_DST`;
const PROC_SEC = `${SANDBOX}_PROC_SEC`;

// Trivial, self-contained TI body: a parameter plus a couple of harmless
// numeric/string variable assignments. Touches nothing on the server.
const PROLOG_A = [
  "# harmless self-contained TI body for live test",
  "nFoo = 1;",
  "nBar = nFoo + pAmount;",
  "sMsg = 'mcp-live-' | NumberToString( nBar );",
].join("\r\n");

describe.skipIf(!LIVE_ENABLED)("live: process (TI development)", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
    // Clean any leftovers from a previous interrupted run (idempotent).
    for (const name of [PROC_A, PROC_B, PROC_BAD, PROC_GIT_SRC, PROC_GIT_DST]) {
      await h.call("tm1_delete_process", { processName: name, confirm: name });
    }
  });

  afterAll(async () => {
    for (const name of [PROC_A, PROC_B, PROC_BAD, PROC_GIT_SRC, PROC_GIT_DST]) {
      try {
        await h.call("tm1_delete_process", { processName: name, confirm: name });
      } catch {
        /* idempotent teardown — ignore missing */
      }
    }
  });

  it("check_process_code validates a harmless body without saving", async () => {
    const r = await h.ok("tm1_check_process_code", {
      name: PROC_A,
      prolog: PROLOG_A,
      parameters: [{ name: "pAmount", type: "Numeric", defaultValue: 0 }],
      dataSource: { type: "None" },
    });
    expect(r.json).toMatchObject({ ok: true, errorCount: 0 });
    expect(r.json.errors).toEqual([]);
  });

  it("upsert_process creates PROC_A with prolog + parameter", async () => {
    const r = await h.ok("tm1_upsert_process", {
      name: PROC_A,
      prolog: PROLOG_A,
      parameters: [
        { name: "pAmount", type: "Numeric", defaultValue: 0, prompt: "Amount" },
      ],
      mode: "upsert",
    });
    expect(r.json).toMatchObject({
      processName: PROC_A,
      action: "created",
    });
    expect(r.json.appliedSteps).toContain("createProcess");
    expect(r.json.appliedSteps).toContain("updateProcessCode");
    expect(r.json.appliedSteps).toContain("updateProcessParameters");
  });

  it("compile_process reports success for PROC_A", async () => {
    const r = await h.ok("tm1_compile_process", { name: PROC_A });
    expect(r.json).toMatchObject({ ok: true, processName: PROC_A, errorCount: 0 });
  });

  it("get_process_code returns the four tabs and the prolog back", async () => {
    const r = await h.ok("tm1_get_process_code", { processName: PROC_A });
    expect(r.json).toMatchObject({
      prolog: expect.any(String),
      metadata: expect.any(String),
      data: expect.any(String),
      epilog: expect.any(String),
    });
    expect(r.json.prolog).toContain("nFoo = 1;");
  });

  it("get_process_parameters returns the declared parameter", async () => {
    const r = await h.ok("tm1_get_process_parameters", {
      processName: PROC_A,
      format: "json",
    });
    expect(r.json.parameters).toBeInstanceOf(Array);
    const pAmount = r.json.parameters.find(
      (p: { name: string }) => p.name === "pAmount",
    );
    expect(pAmount).toBeTruthy();
    expect(pAmount).toMatchObject({ name: "pAmount", type: "Numeric" });
  });

  it("get_process_variables works", async () => {
    const r = await h.ok("tm1_get_process_variables", {
      processName: PROC_A,
      format: "json",
    });
    expect(r.json.variables).toBeInstanceOf(Array);
  });

  it("get_process_datasource returns a None-type datasource", async () => {
    const r = await h.ok("tm1_get_process_datasource", {
      processName: PROC_A,
      format: "json",
    });
    expect(r.json).toBeTruthy();
    expect(r.json.type).toBeTruthy();
  });

  it("execute_process runs the harmless process successfully", async () => {
    const r = await h.ok("tm1_execute_process", {
      processName: PROC_A,
      parameters: { pAmount: 5 },
    });
    expect(r.json).toMatchObject({
      success: true,
      processErrorStatus: "CompletedSuccessfully",
    });
  });

  it("copy_process clones PROC_A to PROC_B", async () => {
    const r = await h.ok("tm1_copy_process", {
      sourceName: PROC_A,
      targetName: PROC_B,
    });
    expect(r.json).toMatchObject({
      success: true,
      sourceName: PROC_A,
      targetName: PROC_B,
    });
  });

  it("diff_processes reports A and B as identical", async () => {
    const r = await h.ok("tm1_diff_processes", {
      processA: PROC_A,
      processB: PROC_B,
    });
    // Each tab result carries an `identical` flag; the copy should match.
    const tabs = r.json.tabResults ?? r.json.tabs ?? {};
    const flags = Object.values(tabs).map(
      (t: unknown) => (t as { identical?: boolean }).identical,
    );
    expect(flags.every((f) => f !== false)).toBe(true);
    expect(JSON.stringify(r.json)).toContain("identical");
  });

  it("validate_process_refs scans PROC_A (no real-object refs)", async () => {
    const r = await h.ok("tm1_validate_process_refs", { processName: PROC_A });
    expect(r.json).toMatchObject({
      processName: PROC_A,
      unresolved: expect.any(Number),
    });
    // Harmless body references no cubes/dimensions → nothing unresolved.
    expect(r.json.unresolved).toBe(0);
  });

  it("diagnose_process_error returns a structured (possibly empty) log set", async () => {
    const r = await h.ok("tm1_diagnose_process_error", {
      processName: PROC_A,
      includeRelated: false,
    });
    expect(r.json).toMatchObject({
      processName: PROC_A,
      logsFound: expect.any(Number),
      logs: expect.any(Array),
    });
  });

  it("a deliberately broken process fails to compile, then diagnose runs", async () => {
    // Upsert a process with a real syntax error (unterminated statement /
    // undefined function call), compile it → expect an error envelope.
    await h.ok("tm1_upsert_process", {
      name: PROC_BAD,
      prolog: "nX = ThisFunctionDoesNotExist( ;",
      mode: "upsert",
    });
    const compiled = await h.call("tm1_compile_process", { name: PROC_BAD });
    expect(compiled.isError).toBe(true);
    expect(compiled.json).toMatchObject({ ok: false });
    expect(compiled.json.errorCount).toBeGreaterThan(0);

    // diagnose accepts a process name and returns a structured envelope
    // regardless of whether a runtime error log exists.
    const diag = await h.ok("tm1_diagnose_process_error", {
      processName: PROC_BAD,
      includeRelated: false,
    });
    expect(diag.json).toMatchObject({
      processName: PROC_BAD,
      logs: expect.any(Array),
    });
  });

  it("get_process_code on a nonexistent process yields an error envelope", async () => {
    const r = await h.call("tm1_get_process_code", {
      processName: `${SANDBOX}_PROC_DOES_NOT_EXIST`,
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });

  it("delete_process removes PROC_B (confirm gate)", async () => {
    const r = await h.ok("tm1_delete_process", {
      processName: PROC_B,
      confirm: PROC_B,
    });
    expect(r.json ?? r.text).toBeTruthy();
    // Gone now: get_process_code should error.
    const gone = await h.call("tm1_get_process_code", { processName: PROC_B });
    expect(gone.isError).toBe(true);
  });

  it("git export->import roundtrip preserves hasSecurityAccess", async () => {
    try {
      // 1. Seed a source process with HasSecurityAccess=true (upsert_process
      // hasSecurityAccess passthrough under test).
      await h.ok("tm1_upsert_process", {
        name: PROC_GIT_SRC,
        prolog: "# harmless git-roundtrip source\nnX = 1;",
        hasSecurityAccess: true,
        mode: "upsert",
      });

      // 2. Export: hasSecurityAccess must be carried into the exported JSON.
      const exp1 = await h.ok("tm1_export_process_to_git", { processName: PROC_GIT_SRC });
      expect(exp1.json.hasSecurityAccess).toBe(true);

      // 3. Retarget the exported JSON to a second process name and import
      // fresh — the canonical git-roundtrip path.
      const retargeted = (exp1.json.json as string).replace(
        `"name": "${PROC_GIT_SRC}"`,
        `"name": "${PROC_GIT_DST}"`,
      );
      const imp = await h.ok("tm1_import_process_from_git", {
        jsonContent: retargeted,
        tiContent: exp1.json.ti,
        mode: "upsert",
      });
      expect(imp.json.processName).toBe(PROC_GIT_DST);
      expect(imp.json.hasSecurityAccess).toBe(true);

      // 4. Re-export the second process: hasSecurityAccess must have survived
      // the second hop too.
      const exp2 = await h.ok("tm1_export_process_to_git", { processName: PROC_GIT_DST });
      expect(exp2.json.hasSecurityAccess).toBe(true);
    } finally {
      for (const name of [PROC_GIT_SRC, PROC_GIT_DST]) {
        try {
          await h.call("tm1_delete_process", { processName: name, confirm: name });
        } catch {
          /* idempotent teardown — ignore missing */
        }
      }
    }
  });
});

describe.skipIf(!LIVE_ENABLED)("HasSecurityAccess read paths (live)", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
    // Own fixture — the top-level "live: process" describe above tears down
    // its own processes (including PROC_A) in its afterAll, which runs before
    // this sibling describe starts, so an independent process is needed here.
    await h.ok("tm1_upsert_process", {
      name: PROC_SEC,
      prolog: "# harmless fixture for HasSecurityAccess read paths\nnX = 1;",
      mode: "upsert",
    });
  });

  afterAll(async () => {
    try {
      await h.call("tm1_delete_process", { processName: PROC_SEC, confirm: PROC_SEC });
    } catch {
      /* idempotent teardown — ignore missing */
    }
  });

  it("getAllCode(false) returns hasSecurityAccess as a boolean on every row", async () => {
    const rows = await h.client.processes.getAllCode(false);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.hasSecurityAccess).toBe("boolean");
    }
  });

  it("getDeployMeta returns a boolean hasSecurityAccess for an existing process", async () => {
    const meta = await h.client.processes.getDeployMeta(PROC_SEC);
    expect(typeof meta.hasSecurityAccess).toBe("boolean");
  });
});

describe.skipIf(!LIVE_ENABLED)("native #region blob round-trip (live)", () => {
  let h: LiveHarness;
  const PROC_GIT_NATIVE = `${SANDBOX}_PROC_GIT_NATIVE`;

  beforeAll(async () => {
    h = await getHarness();
    // Clean any leftover from a previous interrupted run (idempotent).
    await h.client.processes.delete(PROC_GIT_NATIVE).catch(() => {
      /* idempotent — ignore missing */
    });
  });

  afterAll(async () => {
    await h.client.processes.delete(PROC_GIT_NATIVE).catch(() => {
      /* idempotent teardown — ignore missing */
    });
  });

  it("process code round-trips via the native #region blob (getCodeBlob/updateCodeBlob), empty tab cleared", async () => {
    try {
      // Seed a process with 3 non-empty tabs; Metadata is intentionally left
      // empty to exercise the server's "omit empty tab" + "clear on full
      // replace" behavior.
      await h.client.processes.create(PROC_GIT_NATIVE);
      await h.client.processes.updateCodeBlob(
        PROC_GIT_NATIVE,
        "#region Prolog\r\nsP='p';\r\n#endregion\r\n#region Data\r\nsD='d';\r\n#endregion\r\n#region Epilog\r\nsE='e';\r\n#endregion",
      );

      // Export the blob: non-empty tabs present, the empty tab omitted by TM1.
      const blob = await h.client.processes.getCodeBlob(PROC_GIT_NATIVE);
      expect(blob).toContain("#region Prolog");
      expect(blob).toContain("#region Data");
      expect(blob).toContain("#region Epilog");
      expect(blob).not.toContain("#region Metadata"); // empty tab omitted

      // Re-import the exact exported blob (full replace) → tabs match,
      // Metadata cleared to "" since its region is absent from the blob.
      await h.client.processes.updateCodeBlob(PROC_GIT_NATIVE, blob);
      const code = await h.client.processes.getCode(PROC_GIT_NATIVE);
      expect(code.prolog).toContain("sP='p';");
      expect(code.data).toContain("sD='d';");
      expect(code.epilog).toContain("sE='e';");
      expect(code.metadata).toBe("");
    } finally {
      await h.client.processes.delete(PROC_GIT_NATIVE).catch(() => {
        /* idempotent teardown — ignore missing */
      });
    }
  });
});
