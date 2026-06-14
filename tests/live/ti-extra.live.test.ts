// Live coverage for the remaining TI-development + ops tools not exercised
// by the other live suites: .pro export/import/diff/bundle roundtrip, bulk
// code dump, grouped listing, v12 readiness scan, error-log content fetch,
// and thread cancel. Everything mutating stays under the SANDBOX prefix and
// is torn down in afterAll; read-only tools assert shape only.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const PROC_SRC = `${SANDBOX}_PROEXPORT`;
const PROC_IMPORT = `${SANDBOX}_PROIMPORT`;

// Harmless self-contained TI body — touches nothing on the server.
const PROLOG = [
  "# harmless self-contained TI body live test",
  "nFoo = 1;",
  "nBar = nFoo + pAmount;",
  "sMsg = 'mcp-live-' | NumberToString( nBar );",
].join("\r\n");

describe.skipIf(!LIVE_ENABLED)("live: ti-extra (.pro roundtrip + ops gap)", () => {
  let h: LiveHarness;
  let proContent = "";
  let bundleDir = "";

  beforeAll(async () => {
    h = await getHarness();
    // Idempotent pre-clean.
    for (const name of [PROC_SRC, PROC_IMPORT]) {
      await h.call("tm1_delete_process", { processName: name, confirm: name });
    }
    await h.ok("tm1_upsert_process", {
      name: PROC_SRC,
      prolog: PROLOG,
      parameters: [
        { name: "pAmount", type: "Numeric", defaultValue: 0, prompt: "Amount" },
      ],
      mode: "upsert",
    });
  });

  afterAll(async () => {
    for (const name of [PROC_SRC, PROC_IMPORT]) {
      try {
        await h.call("tm1_delete_process", { processName: name, confirm: name });
      } catch {
        /* idempotent teardown */
      }
    }
    if (bundleDir) {
      try {
        await fs.rm(bundleDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("export_process_to_pro returns inline .pro content", async () => {
    const r = await h.ok("tm1_export_process_to_pro", { processName: PROC_SRC });
    expect(r.json).toMatchObject({
      processName: PROC_SRC,
      byteLength: expect.any(Number),
      content: expect.any(String),
    });
    expect(r.json.content).toContain("602"); // .pro Name record
    proContent = r.json.content as string;
  });

  it("diff_process_with_file reports identical against its own export", async () => {
    expect(proContent).not.toBe("");
    const r = await h.ok("tm1_diff_process_with_file", {
      content: proContent,
      processName: PROC_SRC,
    });
    expect(r.json).toMatchObject({ processName: PROC_SRC, identical: true });
  });

  it("import_pro_file creates a new process from .pro content", async () => {
    expect(proContent).not.toBe("");
    const r = await h.ok("tm1_import_pro_file", {
      content: proContent,
      name: PROC_IMPORT,
      mode: "create",
    });
    expect(JSON.stringify(r.json)).toContain(PROC_IMPORT);
    // Confirm it really landed.
    const got = await h.ok("tm1_get_process_code", { processName: PROC_IMPORT });
    expect(got.json.prolog).toContain("nFoo = 1;");
  });

  it("install_pro_bundle dry-run parses a directory without writing", async () => {
    expect(proContent).not.toBe("");
    bundleDir = path.join(os.tmpdir(), "zz_mcp_live_bundle");
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(path.join(bundleDir, `${PROC_SRC}.pro`), proContent, "utf8");
    const r = await h.ok("tm1_install_pro_bundle", {
      directory: bundleDir,
      dryRun: true,
      preflight: true,
    });
    // dryRun parses + preflights and reports the *projected* per-file status
    // (e.g. "updated") without issuing create/update calls. Assert it found
    // the file, ran in dryRun mode, and hit no errors.
    expect(r.json).toMatchObject({ dryRun: true, filesFound: 1 });
    expect(r.json.counts).toMatchObject({ error: 0, preflight_failed: 0 });
  });

  it("get_all_processes_code returns a bounded bulk dump", async () => {
    const r = await h.ok("tm1_get_all_processes_code", { limit: 3 });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
  });

  it("list_processes_grouped returns group summary", async () => {
    const r = await h.ok("tm1_list_processes_grouped", {});
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
  });

  it("check_v12_readiness scans and returns findings summary", async () => {
    const r = await h.ok("tm1_check_v12_readiness", { limit: 50 });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
  });

  it("get_error_log_content fetches a real log or errors cleanly on a bogus name", async () => {
    const list = await h.ok("tm1_list_error_logs", { limit: 1 });
    const items = (list.json?.items ?? list.json) as unknown;
    const first = Array.isArray(items) ? items[0] : undefined;
    const filename =
      typeof first === "string" ? first : (first as { name?: string })?.name;
    if (filename) {
      const r = await h.ok("tm1_get_error_log_content", { filename, tail: 20 });
      expect(r.isError).toBe(false);
      expect(r.json ?? r.text).toBeTruthy();
    } else {
      // No error logs on this server — exercise the not-found path instead.
      const r = await h.call("tm1_get_error_log_content", {
        filename: `${SANDBOX}_DOES_NOT_EXIST.log`,
      });
      expect(r.isError).toBe(true);
    }
  });

  it("cancel_thread on a non-existent id returns a result without throwing", async () => {
    // Never targets a real thread; 999999999 is effectively unassignable.
    const r = await h.call("tm1_cancel_thread", { id: 999999999 });
    expect(typeof r.isError).toBe("boolean");
  });
});
