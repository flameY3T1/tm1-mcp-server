// Live lifecycle: CUBE + CELL/RULES domain end-to-end against a real TM1
// server. Builds two sandbox dimensions (one element carries a single quote to
// exercise OData literal escaping), a cube over them, then exercises the full
// cell + rules tool surface and tears everything down idempotently.
//
// Opt-in: skips unless TM1_BASE_URL + TM1_USER are set. Every object is
// prefixed `${SANDBOX}_CUBE` so a stray run can never touch real model data.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const D1 = `${SANDBOX}_CUBE_D1`;
const D2 = `${SANDBOX}_CUBE_D2`;
const C1 = `${SANDBOX}_CUBE_C1`;

// D1 elements: a plain leaf and a leaf whose name contains a single quote, so
// every coordinate lookup (get_cell_value, write_cells, MDX, sample) drives the
// OData single-quote escaping path ('' doubling) at least once.
const D1_PLAIN = "E1";
const D1_QUOTE = "O'Brien"; // single quote → tests OData escaping
const D2_A = "A1";
const D2_B = "A2";

describe.skipIf(!LIVE_ENABLED)("live: cube + cell/rules lifecycle", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();

    // Clean any leftovers from a crashed prior run (idempotent).
    await h.call("tm1_delete_cube", { name: C1, confirm: C1 });
    await h.call("tm1_delete_dimension", { name: D1, confirm: D1 });
    await h.call("tm1_delete_dimension", { name: D2, confirm: D2 });

    // Dimensions first — a cube cannot be created without them.
    await h.ok("tm1_create_dimension", { name: D1 });
    await h.ok("tm1_create_dimension", { name: D2 });

    // Populate. create_dimension makes a default hierarchy of the same name.
    for (const name of [D1_PLAIN, D1_QUOTE]) {
      await h.ok("tm1_create_element", {
        dimensionName: D1,
        hierarchyName: D1,
        element: { name, type: "Numeric" },
      });
    }
    for (const name of [D2_A, D2_B]) {
      await h.ok("tm1_create_element", {
        dimensionName: D2,
        hierarchyName: D2,
        element: { name, type: "Numeric" },
      });
    }

    // Cube over the two dimensions. Order matters for perf, not for the test.
    await h.ok("tm1_create_cube", { name: C1, dimensions: [D1, D2] });
  });

  afterAll(async () => {
    // Idempotent teardown — swallow per-object errors so one failure does not
    // leak the rest. Cube must go before its dimensions (dim delete fails while
    // referenced by a cube).
    const swallow = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* best-effort cleanup */
      }
    };
    await swallow(h.call("tm1_delete_cube", { name: C1, confirm: C1 }));
    await swallow(h.call("tm1_delete_dimension", { name: D1, confirm: D1 }));
    await swallow(h.call("tm1_delete_dimension", { name: D2, confirm: D2 }));
  });

  it("create_cube produced a cube over the two sandbox dimensions", async () => {
    const r = await h.ok("tm1_list_cubes", { nameContains: SANDBOX, fetchAll: true });
    const found = (r.json.items as Array<{ name: string }>).find((c) => c.name === C1);
    expect(found).toBeTruthy();
  });

  it("write_cells then get_cell_value round-trips a value (plain coord)", async () => {
    await h.ok("tm1_write_cells", {
      cubeName: C1,
      dimensions: [D1, D2],
      cells: [{ elements: [D1_PLAIN, D2_A], value: 42 }],
    });
    const r = await h.ok("tm1_get_cell_value", {
      cubeName: C1,
      elements: [D1_PLAIN, D2_A],
    });
    expect(r.json.value).toBe(42);
  });

  it("write_cells + get_cell_value round-trips through the single-quote element (OData escaping)", async () => {
    await h.ok("tm1_write_cells", {
      cubeName: C1,
      dimensions: [D1, D2],
      cells: [{ elements: [D1_QUOTE, D2_B], value: 7 }],
    });
    const r = await h.ok("tm1_get_cell_value", {
      cubeName: C1,
      elements: [D1_QUOTE, D2_B],
    });
    expect(r.json.value).toBe(7);
  });

  it("check_writable_coords reports leaf coords as writable", async () => {
    const r = await h.ok("tm1_check_writable_coords", {
      cubeName: C1,
      coords: [D1_PLAIN, D2_A],
    });
    expect(r.json.writable).toBe(true);
    expect(r.json.allElementsExist).toBe(true);
    expect(r.json.allElementsNLevel).toBe(true);
  });

  it("sample_cells returns the populated cells", async () => {
    const r = await h.ok("tm1_sample_cells", { cubeName: C1, maxCells: 10 });
    expect(Array.isArray(r.json.cells)).toBe(true);
    // We wrote two non-zero leaf cells above.
    expect(r.json.cells.length).toBeGreaterThanOrEqual(1);
  });

  it("execute_mdx over the cube returns a cellset", async () => {
    const mdx =
      `SELECT NON EMPTY {[${D1}].[${D1}].Members} ON COLUMNS, ` +
      `NON EMPTY {[${D2}].[${D2}].Members} ON ROWS ` +
      `FROM [${C1}]`;
    const r = await h.ok("tm1_execute_mdx", { mdx });
    expect(r.json).toMatchObject({ count: expect.any(Number), items: expect.any(Array) });
    expect(r.json.items.length).toBeGreaterThan(0);
  });

  it("get_cube_stats returns metrics for the cube", async () => {
    const r = await h.ok("tm1_get_cube_stats", { cubeName: C1 });
    expect(r.json.count).toBe(1);
    expect(r.json.items[0].cubeName).toBe(C1);
    expect(r.json.items[0].error).toBeUndefined();
  });

  it("check_cube_rule validates a trivial rule without applying it", async () => {
    const rules = `SKIPCHECK;\n['${D1_PLAIN}'] = N: 1;\nFEEDERS;`;
    const r = await h.ok("tm1_check_cube_rule", { cubeName: C1, rules });
    expect(r.json.ok).toBe(true);
    expect(r.json.errorCount).toBe(0);
  });

  it("set_cube_rules then get_cube_rules reads the rule back", async () => {
    const rules = `SKIPCHECK;\n['${D1_PLAIN}'] = N: 1;\nFEEDERS;`;
    await h.ok("tm1_set_cube_rules", { cubeName: C1, rules });
    const r = await h.ok("tm1_get_cube_rules", { cubeName: C1 });
    const text = typeof r.json === "string" ? r.json : (r.json.rules ?? r.text);
    expect(String(text)).toContain("SKIPCHECK");
    expect(String(text)).toContain(D1_PLAIN);
  });

  it("get_all_cube_rules includes the sandbox cube (summary mode)", async () => {
    const r = await h.ok("tm1_get_all_cube_rules", { onlyWithRules: true, summary: true });
    const cubes = r.json.cubes as Array<{ cubeName: string }>;
    expect(cubes.some((c) => c.cubeName === C1)).toBe(true);
  });

  it("search_rules finds the SKIPCHECK line in the sandbox cube", async () => {
    const r = await h.ok("tm1_search_rules", { pattern: "SKIPCHECK", cubes: [C1] });
    expect(r.json.matchCount).toBeGreaterThanOrEqual(1);
    const items = r.json.items as Array<{ cube: string }>;
    expect(items.some((m) => m.cube === C1)).toBe(true);
  });

  it("clear_cube wipes the cube (confirm required)", async () => {
    const r = await h.call("tm1_clear_cube", {
      cubeName: C1,
      dimensions: [D1, D2],
      tuples: [[], []], // empty arrays = all elements → clear everything
      confirm: C1,
    });
    expect(r.isError).toBeFalsy();
  });

  it("unload_cube succeeds on the sandbox cube", async () => {
    const r = await h.call("tm1_unload_cube", { cubeName: C1 });
    expect(r.isError).toBeFalsy();
  });

  it("get_cell_value with a bad element returns an error envelope, not a throw", async () => {
    const r = await h.call("tm1_get_cell_value", {
      cubeName: C1,
      elements: ["ZZ_NO_SUCH_ELEMENT", D2_A],
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
