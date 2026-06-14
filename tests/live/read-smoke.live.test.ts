// Read-tier smoke: non-mutating tools against the live server. Validates the
// harness mechanism (registry capture, schema parsing, error normalization)
// and the read surface. Mutates nothing — also passes against a readonly-mode
// server's tool set.
import { describe, it, expect, beforeAll } from "vitest";
import { getHarness, LIVE_ENABLED, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: read smoke", () => {
  let h: LiveHarness;
  beforeAll(async () => {
    h = await getHarness();
  });

  it("registers the full readwrite tool set", () => {
    const names = h.toolNames();
    expect(names.length).toBeGreaterThan(90);
    expect(names).toContain("tm1_get_server_info");
    expect(names).toContain("tm1_write_cells"); // readwrite-only tool present
  });

  it("get_server_info returns version", async () => {
    const r = await h.ok("tm1_get_server_info");
    expect(r.json).toBeTruthy();
    expect(JSON.stringify(r.json)).toMatch(/\d+\.\d+/);
  });

  it("list_cubes returns a pagination envelope", async () => {
    const r = await h.ok("tm1_list_cubes", { limit: 5 });
    expect(r.json).toMatchObject({
      total: expect.any(Number),
      count: expect.any(Number),
      items: expect.any(Array),
    });
  });

  it("list_dimensions works", async () => {
    const r = await h.ok("tm1_list_dimensions", { limit: 5 });
    expect(r.json.items).toBeInstanceOf(Array);
  });

  it("list_processes works", async () => {
    const r = await h.ok("tm1_list_processes", { limit: 5 });
    expect(r.json.items).toBeInstanceOf(Array);
  });

  it("bad nameRegex yields canonical VALIDATION_ERROR envelope", async () => {
    const r = await h.call("tm1_list_cubes", { nameRegex: "[unclosed" });
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(r.json.hint).toBeTruthy();
  });

  it("unknown element returns an error envelope, not a throw", async () => {
    const r = await h.call("tm1_get_hierarchy", {
      dimensionName: "ZZ_MCP_LIVE_DOES_NOT_EXIST",
      hierarchyName: "ZZ_MCP_LIVE_DOES_NOT_EXIST",
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
