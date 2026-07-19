// Live integration: the ANALYSIS / AUDIT domain. Every read-only analysis and
// audit tool is exercised end-to-end against the live HRPlan (TM1 11.8) model,
// through the real tool layer (zod schema → withAnnotations → handler →
// TM1Client → OData), exactly as an MCP client would call it.
//
// Strictly read-only: this suite creates and mutates NOTHING. Real object names
// (cubes, processes, rule-bearing cubes, real cell coordinates) are discovered
// dynamically via list_*/sample_cells, never hardcoded, so it adapts to whatever
// the live model contains. Slow/global tools (transaction log) are avoided and
// every scope is kept small to finish well inside the 120s timeout.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, type LiveHarness } from "./harness.js";

describe.skipIf(!LIVE_ENABLED)("live: analysis / audit domain", () => {
  let h: LiveHarness;

  // Discovered once in beforeAll and reused across tests.
  let cubeNames: string[] = [];
  let processNames: string[] = [];
  let ruleCube: string | undefined; // a non-control cube that has rules
  let sampleCube: string | undefined; // rule cube we found a real cell in
  let sampleElements: string[] | undefined; // real cell coords, dim order

  beforeAll(async () => {
    h = await getHarness();

    // ── Discover real cubes (with hasRules) and processes ──────────────────
    const cubes = await h.ok("tm1_list_cubes", {
      fetchAll: true,
      includeRules: true,
      includeDimensions: true,
      includeControl: false,
    });
    const cubeItems: Array<{ name: string; hasRules?: boolean; dimensions?: string[] }> =
      cubes.json?.items ?? [];
    cubeNames = cubeItems.map((c) => c.name);

    const procs = await h.ok("tm1_list_processes", { fetchAll: true });
    processNames = (procs.json?.items ?? [])
      .map((p: unknown) => (typeof p === "string" ? p : (p as { name?: string })?.name))
      .filter((n: unknown): n is string => typeof n === "string");

    // ── Find a rule-bearing cube and a real populated cell inside it ───────
    const ruleCubes = cubeItems.filter((c) => c.hasRules && !c.name.startsWith("}"));
    for (const c of ruleCubes) {
      ruleCube ??= c.name;
      const dims = c.dimensions ?? [];
      if (dims.length === 0) continue;
      // sample_cells returns self-describing {coordinates: {dim->el}} cells.
      const sample = await h.call("tm1_sample_cells", { cubeName: c.name, maxCells: 1 });
      const cell = sample.json?.cells?.[0];
      const coords: Record<string, string> | undefined = cell?.coordinates;
      if (!coords) continue;
      const els = dims.map((d) => coords[d]);
      if (els.every((e) => typeof e === "string" && e.length > 0)) {
        sampleCube = c.name;
        sampleElements = els as string[];
        break;
      }
    }
  });

  afterAll(async () => {
    // No-op: this suite creates nothing, so there is nothing to clean up.
  });

  // ── search_code (ti-development) ────────────────────────────────────────
  it("tm1_search_code: regex over TI code returns paginated envelope", async () => {
    const r = await h.ok("tm1_search_code", { pattern: "If", limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      processesScanned: expect.any(Number),
      matchCount: expect.any(Number),
      items: expect.any(Array),
    });
  });

  it("tm1_search_code: groupBy='process' returns sorted count aggregation", async () => {
    const r = await h.ok("tm1_search_code", { pattern: "If", groupBy: "process", limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      groupBy: "process",
      groupCount: expect.any(Number),
      matchCount: expect.any(Number),
      items: expect.any(Array),
    });
    const items = r.json.items as Array<{ process: string; matchCount: number }>;
    // sorted desc by matchCount
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.matchCount).toBeGreaterThanOrEqual(items[i]!.matchCount);
    }
  });

  // ── search_rules (model-building) ───────────────────────────────────────
  it("tm1_search_rules: regex over cube rules returns envelope", async () => {
    const r = await h.ok("tm1_search_rules", { pattern: ".", limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ items: expect.any(Array) });
    expect(typeof r.json.matchCount === "number" || Array.isArray(r.json.items)).toBe(true);
  });

  // ── analyze_object_usage ────────────────────────────────────────────────
  it("tm1_analyze_object_usage: cube reference scan", async () => {
    expect(cubeNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_analyze_object_usage", {
      kind: "cube",
      objectName: cubeNames[0],
      limit: 50,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      kind: "cube",
      count: expect.any(Number),
      usages: expect.any(Array),
    });

    const s = await h.ok("tm1_analyze_object_usage", {
      kind: "cube",
      objectName: cubeNames[0],
      mode: "summary",
      limit: 50,
    });
    expect(s.isError).toBe(false);
    expect(s.json).toMatchObject({
      kind: "cube",
      mode: "summary",
      sourceCount: expect.any(Number),
      sources: expect.any(Array),
    });
    const sources = s.json.sources as Array<{ count: number }>;
    for (let i = 1; i < sources.length; i++) {
      expect(sources[i - 1]!.count).toBeGreaterThanOrEqual(sources[i]!.count);
    }
  });

  // ── analyze_callgraph: per-process traversal ────────────────────────────
  it("tm1_analyze_callgraph: downstream from a real process (compact)", async () => {
    expect(processNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_analyze_callgraph", {
      start: processNames[0],
      direction: "downstream",
      mode: "compact",
      maxDepth: 3,
    });
    expect(r.isError).toBe(false);
    // Either a tree payload, or a structured "not found in index" warning —
    // both are valid non-error JSON shapes for a real-but-leaf process.
    expect(r.json).toBeTruthy();
    expect(r.json.tree !== undefined || r.json.warning !== undefined).toBe(true);
  });

  // ── analyze_callgraph: global ranking form (no start) ────────────────────
  it("tm1_analyze_callgraph: global fan-out ranking (no start)", async () => {
    const r = await h.ok("tm1_analyze_callgraph", { rankBy: "outgoing", topN: 10 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ mode: "globalRanking" });
    // Ranking returns an array of per-process entries under some key.
    const arr = r.json.ranking ?? r.json.entries ?? r.json.processes;
    expect(Array.isArray(arr)).toBe(true);
  });

  // ── audit_complexity (small scope) ──────────────────────────────────────
  it("tm1_audit_complexity: processes scope, small topN", async () => {
    const r = await h.ok("tm1_audit_complexity", { scope: ["processes"], topN: 5 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      status: expect.any(String),
      scanned: expect.any(Object),
      topProcesses: expect.any(Array),
    });
  });

  // ── audit_naming (small scope) ──────────────────────────────────────────
  it("tm1_audit_naming: cubes+dimensions scope", async () => {
    const r = await h.ok("tm1_audit_naming", {
      scope: ["cubes", "dimensions"],
      maxFindings: 20,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
    expect("findings" in r.json || "findingsByGroup" in r.json).toBe(true);
  });

  // ── audit_feeders (static, small) ───────────────────────────────────────
  it("tm1_audit_feeders: static scan, small topN", async () => {
    const r = await h.ok("tm1_audit_feeders", { mode: "static", topN: 10 });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
    // findings array under some key; assert object shape at minimum.
    expect(typeof r.json).toBe("object");
  });

  // ── check_v12_readiness ─────────────────────────────────────────────────
  it("tm1_check_v12_readiness: scan processes+rules", async () => {
    const r = await h.ok("tm1_check_v12_readiness", { scope: "all", maxFindings: 20 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      readinessScore: expect.any(String),
      findings: expect.any(Array),
      summary: expect.any(Object),
    });
  });

  // ── get_cube_stats: real cube ───────────────────────────────────────────
  it("tm1_get_cube_stats: single real cube", async () => {
    expect(cubeNames.length).toBeGreaterThan(0);
    const r = await h.ok("tm1_get_cube_stats", { cubeName: cubeNames[0] });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ count: expect.any(Number), items: expect.any(Array) });
    expect(r.json.items[0]).toMatchObject({ cubeName: expect.any(String) });
  });

  // ── get_cube_stats: negative path ───────────────────────────────────────
  it("tm1_get_cube_stats: nonexistent cube → per-item error (no whole-call failure)", async () => {
    const r = await h.call("tm1_get_cube_stats", {
      cubeName: "ZZ_NO_SUCH_CUBE_LIVE_TEST",
    });
    // Per-cube errors surface as items[].error rather than failing the call.
    expect(r.json).toBeTruthy();
    expect(r.json.items?.[0]?.error).toBeTruthy();
  });

  // ── get_cube_stats: mutually-exclusive args → isError + json.error ───────
  it("tm1_get_cube_stats: both cubeName and cubeNames → isError", async () => {
    const r = await h.call("tm1_get_cube_stats", {
      cubeName: "A",
      cubeNames: ["B"],
    });
    expect(r.isError).toBe(true);
    expect(r.json?.error).toBeTruthy();
  });

  // ── find_orphan_dimensions ──────────────────────────────────────────────
  it("tm1_find_orphan_dimensions: model hygiene check", async () => {
    const r = await h.ok("tm1_find_orphan_dimensions", { fetchAll: true });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      totalDimensions: expect.any(Number),
      totalCubes: expect.any(Number),
      orphanCount: expect.any(Number),
      items: expect.any(Array),
    });
  });

  // ── invalidate_callgraph_cache ──────────────────────────────────────────
  it("tm1_invalidate_callgraph_cache: drops the index cache", async () => {
    const r = await h.ok("tm1_invalidate_callgraph_cache");
    expect(r.isError).toBe(false);
    // `cleared` is a count of dropped index entries (number).
    expect(r.json).toHaveProperty("cleared");
    expect(typeof r.json.cleared).toBe("number");
  });

  // ── check_feeders (v11 runtime, real cell) ──────────────────────────────
  it("tm1_check_feeders: real cell in a rule-bearing cube", async () => {
    if (!sampleCube || !sampleElements) {
      // No rule cube with a discoverable populated cell — skip gracefully.
      return;
    }
    const r = await h.call("tm1_check_feeders", {
      cubeName: sampleCube,
      elements: sampleElements,
    });
    // Empty fedCells (fully-fed) is a valid non-error result on 11.8.
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ count: expect.any(Number), fedCells: expect.any(Array) });
  });

  // ── trace_feeders (v11 runtime, real cell) ──────────────────────────────
  it("tm1_trace_feeders: real cell in a rule-bearing cube", async () => {
    if (!sampleCube || !sampleElements) return;
    const r = await h.call("tm1_trace_feeders", {
      cubeName: sampleCube,
      elements: sampleElements,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ count: expect.any(Number), fedCells: expect.any(Array) });
  });

  // ── trace_cell_calculation (v11 runtime, real cell) ─────────────────────
  it("tm1_trace_cell_calculation: real cell component tree", async () => {
    if (!sampleCube || !sampleElements) return;
    const r = await h.call("tm1_trace_cell_calculation", {
      cubeName: sampleCube,
      elements: sampleElements,
      maxDepth: 2,
      maxComponents: 10,
    });
    expect(r.isError).toBe(false);
    expect(r.json).toBeTruthy();
    expect(typeof r.json).toBe("object");
  });
});
