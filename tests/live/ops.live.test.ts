// Live integration: OPERATIONS / MONITORING / SECURITY / FILES domains.
//
// Drives the real MCP tool layer (zod schema -> withAnnotations -> handler ->
// TM1Client -> OData) against a running TM1 11.8 server, exactly as an MCP
// client would. Read-tier tools assert no error + plausible shape (NOT
// non-emptiness — an idle server returns empty thread/session/log arrays).
//
// Safe lifecycles exercised end-to-end under the SANDBOX prefix:
//   - FILE: upload -> get_file_content (content round-trip) -> delete.
//   - CLIENT: create -> update -> get -> assign/remove group -> delete.
// Everything created is prefixed `${SANDBOX}_OPS*` and torn down in afterAll.
//
// Deliberately AVOIDED: tm1_get_transaction_log (30s full-scan timeout trap)
// and tm1_save_data (global flush). There is no tm1_create_group tool, so no
// sandbox group is created — group assign/remove reuses an existing group and
// is fully reversed in the same test (and afterAll).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const PREFIX = `${SANDBOX}_OPS`;
const FILE_NAME = `${PREFIX}_FILE.txt`;
const FILE_BODY = `${PREFIX} synthetic live-test blob\nline2\nline3\n`;
const CLIENT_NAME = `${PREFIX}_CLIENT`;

describe.skipIf(!LIVE_ENABLED)("live: ops / monitoring / security / files", () => {
  let h: LiveHarness;
  // Set when the client lifecycle actually created the client, so teardown is
  // idempotent and never deletes something it didn't make.
  let createdClient = false;
  // Group the sandbox client was assigned to (for guaranteed teardown removal).
  let assignedGroup: string | undefined;

  beforeAll(async () => {
    h = await getHarness();
  });

  afterAll(async () => {
    // Each step independently try/caught — teardown must be idempotent.
    try {
      await h.call("tm1_delete_file", { fileName: FILE_NAME, confirm: FILE_NAME });
    } catch {
      /* already gone */
    }
    if (createdClient) {
      if (assignedGroup) {
        try {
          await h.call("tm1_remove_client_group", {
            clientName: CLIENT_NAME,
            groupName: assignedGroup,
            confirm: CLIENT_NAME,
          });
        } catch {
          /* already removed */
        }
      }
      try {
        await h.call("tm1_delete_client", { name: CLIENT_NAME, confirm: CLIENT_NAME });
      } catch {
        /* already gone */
      }
    }
  });

  // ---- OPERATIONS / MONITORING (read-tier) -------------------------------

  it("tm1_get_server_info returns identity + config", async () => {
    const r = await h.ok("tm1_get_server_info");
    expect(r.json).toBeTruthy();
    expect(r.json).toHaveProperty("productVersion");
    expect(JSON.stringify(r.json)).toMatch(/\d+\.\d+/);
  });

  it("tm1_get_server_state returns health snapshot", async () => {
    const r = await h.ok("tm1_get_server_state");
    expect(r.json).toMatchObject({
      connected: expect.any(Boolean),
      counts: expect.any(Object),
    });
    // Counts buckets are { count: number|null }.
    expect(r.json.counts).toHaveProperty("cubes");
    expect(r.json.counts).toHaveProperty("dimensions");
  });

  it("tm1_get_message_log returns entries (small limit)", async () => {
    const r = await h.ok("tm1_get_message_log", { top: 5 });
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      entries: expect.any(Array),
    });
    expect(r.json.entries.length).toBeLessThanOrEqual(5);
  });

  it("tm1_list_threads returns pagination envelope", async () => {
    const r = await h.ok("tm1_list_threads", { limit: 10 });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
  });

  it("tm1_list_sessions returns pagination envelope", async () => {
    const r = await h.ok("tm1_list_sessions", { limit: 10, withThreads: false });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
  });

  it("tm1_get_audit_log returns entries (may be empty if auditing off)", async () => {
    const r = await h.ok("tm1_get_audit_log", { top: 5 });
    expect(r.json).toMatchObject({
      count: expect.any(Number),
      entries: expect.any(Array),
    });
  });

  it("tm1_list_error_logs returns pagination envelope", async () => {
    const r = await h.ok("tm1_list_error_logs", { limit: 10 });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
  });

  it("tm1_list_error_logs groupBy='process' returns audit summary", async () => {
    const r = await h.ok("tm1_list_error_logs", { groupBy: "process", limit: 20 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      groupBy: "process",
      totalFiles: expect.any(Number),
      groupCount: expect.any(Number),
      items: expect.any(Array),
    });
    const items = r.json.items as Array<{ process: string; count: number; perDay: number }>;
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.count).toBeGreaterThanOrEqual(items[i]!.count);
    }
  });

  // ---- SECURITY (read-tier) ----------------------------------------------

  it("tm1_list_clients returns clients with Name", async () => {
    const r = await h.ok("tm1_list_clients", { limit: 50 });
    expect(r.json.items).toBeInstanceOf(Array);
    expect(r.json.items.length).toBeGreaterThan(0); // admin always exists
    expect(r.json.items[0]).toHaveProperty("Name");
  });

  it("tm1_list_groups returns groups with Name", async () => {
    const r = await h.ok("tm1_list_groups", { limit: 50 });
    expect(r.json.items).toBeInstanceOf(Array);
    expect(r.json.items.length).toBeGreaterThan(0); // ADMIN group always exists
    expect(r.json.items[0]).toHaveProperty("Name");
  });

  it("tm1_get_client fetches an existing client", async () => {
    const list = await h.ok("tm1_list_clients", { limit: 50 });
    const names: string[] = list.json.items
      .map((c: { Name?: string }) => c.Name)
      .filter((n: unknown): n is string => typeof n === "string");
    expect(names.length).toBeGreaterThan(0);
    // Prefer 'admin' if present, else first listed.
    const target = names.find((n) => n.toLowerCase() === "admin") ?? names[0];
    const r = await h.ok("tm1_get_client", { name: target });
    expect(r.json).toHaveProperty("Name");
    expect(r.json.Name).toBe(target);
  });

  // ---- FILES (read-tier) --------------------------------------------------

  it("tm1_list_files returns a file listing envelope", async () => {
    const r = await h.ok("tm1_list_files", { limit: 20 });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
    expect(r.json).toHaveProperty("path");
  });

  it("tm1_search_files returns a search envelope", async () => {
    const r = await h.ok("tm1_search_files", { contains: ["."], limit: 20 });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      items: expect.any(Array),
    });
  });

  // ---- FILE lifecycle (safe, reversible) ---------------------------------

  it("FILE lifecycle: upload -> read back -> delete", async () => {
    const up = await h.ok("tm1_upload_file", {
      fileName: FILE_NAME,
      content: FILE_BODY,
    });
    expect(up.json).toMatchObject({ success: true, fileName: FILE_NAME });
    expect(up.json.bytesUploaded).toBe(Buffer.byteLength(FILE_BODY, "utf8"));

    const get = await h.ok("tm1_get_file_content", { fileName: FILE_NAME });
    expect(get.json.fileName).toBe(FILE_NAME);
    expect(get.json.content).toBe(FILE_BODY);
    expect(get.json.truncated).toBe(false);

    const del = await h.ok("tm1_delete_file", { fileName: FILE_NAME, confirm: FILE_NAME });
    expect(del.json).toMatchObject({ success: true, deleted: true });

    // Confirm gone: subsequent read errors with NOT_FOUND.
    const after = await h.call("tm1_get_file_content", { fileName: FILE_NAME });
    expect(after.isError).toBe(true);
  });

  // ---- Negative path ------------------------------------------------------

  it("tm1_get_file_content on nonexistent file -> isError + json.code", async () => {
    const r = await h.call("tm1_get_file_content", {
      fileName: `${PREFIX}_DOES_NOT_EXIST_${Date.now()}.txt`,
    });
    expect(r.isError).toBe(true);
    expect(r.json).toBeTruthy();
    expect(r.json).toHaveProperty("code");
    expect(typeof r.json.code).toBe("string");
  });

  // ---- CLIENT lifecycle (safe: create -> update -> group -> delete) ------

  it("CLIENT lifecycle: create -> update -> get -> assign/remove group -> delete", async () => {
    // Create a sandbox client (no groups, with a throwaway password).
    const create = await h.call("tm1_create_client", {
      name: CLIENT_NAME,
      password: "ZzMcpLive!2026",
      friendlyName: `${PREFIX} live test`,
    });
    if (create.isError) {
      // Some 11.8 configs (external auth / CAM) reject local client creation.
      // Don't fail the suite — assert the error is structured and skip mutation.
      expect(create.json).toHaveProperty("code");
      return;
    }
    createdClient = true;
    expect(create.json).toMatchObject({ success: true, name: CLIENT_NAME });

    // get_client sees it.
    const got = await h.ok("tm1_get_client", { name: CLIENT_NAME });
    expect(got.json.Name).toBe(CLIENT_NAME);

    // update_client: flip enabled + change friendly name.
    const upd = await h.ok("tm1_update_client", {
      name: CLIENT_NAME,
      friendlyName: `${PREFIX} updated`,
      enabled: true,
    });
    expect(upd.json).toMatchObject({ success: true });

    // Group assign/remove against an existing real group (fully reversed here).
    const groups = await h.ok("tm1_list_groups", { limit: 50 });
    const groupNames: string[] = (groups.json.items ?? [])
      .map((g: { Name?: string }) => g.Name)
      .filter((n: unknown): n is string => typeof n === "string");
    // Avoid ADMIN/SecurityAdmin/DataAdmin to never grant privileges; pick a
    // plain group if one exists.
    const safeGroup = groupNames.find(
      (n) => !/admin/i.test(n) && !/operationsadmin/i.test(n),
    );
    if (safeGroup) {
      assignedGroup = safeGroup;
      const asg = await h.ok("tm1_assign_client_group", {
        clientName: CLIENT_NAME,
        groupName: safeGroup,
      });
      expect(asg.json).toMatchObject({ success: true });

      const rem = await h.ok("tm1_remove_client_group", {
        clientName: CLIENT_NAME,
        groupName: safeGroup,
        confirm: CLIENT_NAME,
      });
      expect(rem.json).toMatchObject({ success: true });
      assignedGroup = undefined; // removed cleanly
    }

    // delete_client removes it.
    const del = await h.ok("tm1_delete_client", { name: CLIENT_NAME, confirm: CLIENT_NAME });
    expect(del.json).toMatchObject({ success: true, clientName: CLIENT_NAME });
    createdClient = false; // gone; teardown no-op
  });
});
