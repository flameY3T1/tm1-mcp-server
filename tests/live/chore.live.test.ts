// Live lifecycle test for the CHORE (scheduling) domain. Drives the real MCP
// tool layer against a running TM1 server, exactly as an MCP client would.
//
// User intent (verbatim): "bitte einen internen test implementieren der jedes
// tool mit jeder funktionalität gegen den testserver live verprobt."
//
// Covers: tm1_create_chore, tm1_list_chores, tm1_toggle_chore,
// tm1_update_chore, tm1_execute_chore, tm1_analyze_chore_graph,
// tm1_delete_chore (+ tm1_upsert_process for the prerequisite process).
//
// SAFETY: every object is prefixed with `${SANDBOX}_CHORE`. The chore is
// created DEACTIVATED (active:false) and afterAll deletes it, so it can never
// fire on a schedule after the test. The bound process is harmless: prolog
// `nX = 1;`, no data source. Teardown is idempotent (try/catch each).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const PROC = `${SANDBOX}_CHORE_PROC`;
const CHORE = `${SANDBOX}_CHORE_A`;
// Far-future start time, explicit UTC offset, deactivated → never auto-runs.
const START = "2099-01-01T06:00:00Z";

describe.skipIf(!LIVE_ENABLED)("live: chore lifecycle", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();
    // Prerequisite: a harmless process for the chore to reference.
    await h.ok("tm1_upsert_process", {
      name: PROC,
      prolog: "nX = 1;",
      mode: "upsert",
    });
  });

  afterAll(async () => {
    // Idempotent teardown. Delete the chore FIRST so it can never fire, then
    // the process. Swallow errors so one failure doesn't mask the other.
    try {
      await h.call("tm1_delete_chore", { choreName: CHORE, confirm: CHORE });
    } catch {
      /* already gone */
    }
    try {
      await h.call("tm1_delete_process", { processName: PROC });
    } catch {
      /* already gone */
    }
  });

  it("create_chore creates a deactivated chore", async () => {
    const r = await h.ok("tm1_create_chore", {
      choreName: CHORE,
      startTime: START,
      active: false, // never auto-runs
      frequency: { days: 1, hours: 0, minutes: 0, seconds: 0 },
      steps: [{ process: PROC, parameters: [] }],
    });
    expect(r.json).toMatchObject({
      success: true,
      name: CHORE,
      stepCount: 1,
      active: false,
    });
  });

  it("list_chores shows the new chore", async () => {
    const r = await h.ok("tm1_list_chores", { fetchAll: true });
    const found = (r.json.items ?? []).find(
      (c: { name?: string }) => c?.name === CHORE,
    );
    expect(found).toBeTruthy();
    expect(found.active).toBe(false);
    // Steps reference our process.
    const procNames: string[] = (found.processes ?? []).map(
      (p: { name: string }) => p.name,
    );
    expect(procNames).toContain(PROC);
  });

  it("toggle_chore flips active state", async () => {
    // Activate.
    const on = await h.ok("tm1_toggle_chore", { choreName: CHORE, active: true });
    expect(on.json).toMatchObject({ success: true, choreName: CHORE, active: true });
    const afterOn = await h.ok("tm1_list_chores", { fetchAll: true });
    const onItem = afterOn.json.items.find((c: { name?: string }) => c?.name === CHORE);
    expect(onItem.active).toBe(true);

    // Deactivate again (leave it OFF — schedule must never fire post-test).
    const off = await h.ok("tm1_toggle_chore", { choreName: CHORE, active: false });
    expect(off.json).toMatchObject({ success: true, choreName: CHORE, active: false });
    const afterOff = await h.ok("tm1_list_chores", { fetchAll: true });
    const offItem = afterOff.json.items.find((c: { name?: string }) => c?.name === CHORE);
    expect(offItem.active).toBe(false);
  });

  it("update_chore changes the start time", async () => {
    const NEW_START = "2099-06-15T09:30:00Z";
    const r = await h.ok("tm1_update_chore", {
      choreName: CHORE,
      startTime: NEW_START,
    });
    expect(r.json).toMatchObject({ success: true, choreName: CHORE });
    // Verify it stuck. TM1 may render the StartTime in its own format/zone,
    // so assert the date portion rather than an exact string match.
    const after = await h.ok("tm1_list_chores", { fetchAll: true });
    const item = after.json.items.find((c: { name?: string }) => c?.name === CHORE);
    expect(item).toBeTruthy();
    expect(String(item.startTime)).toContain("2099-06-15");
  });

  it("execute_chore runs it once on demand", async () => {
    // Chore is deactivated; on-demand execute bypasses the schedule.
    const r = await h.ok("tm1_execute_chore", { choreName: CHORE });
    expect(r.json).toMatchObject({ success: true, choreName: CHORE });
  });

  it("analyze_chore_graph returns task structure", async () => {
    const r = await h.ok("tm1_analyze_chore_graph", { choreName: CHORE });
    expect(r.json.choreName).toBeTruthy();
    expect(Array.isArray(r.json.tasks)).toBe(true);
    expect(r.json.tasks.length).toBeGreaterThanOrEqual(1);
    const t0 = r.json.tasks[0];
    expect(t0.processName).toBe(PROC);
    expect(t0.tree).toBeTruthy();
  });

  it("delete_chore on a nonexistent chore returns an error envelope", async () => {
    const r = await h.call("tm1_delete_chore", {
      choreName: `${SANDBOX}_CHORE_DOES_NOT_EXIST`,
      confirm: `${SANDBOX}_CHORE_DOES_NOT_EXIST`,
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
