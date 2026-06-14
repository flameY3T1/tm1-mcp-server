// Live VIEW + SUBSET lifecycle against a real TM1 server. Exercises every tool
// in the views/ and subsets/ tool domains end-to-end through the MCP tool layer
// (zod schema → withAnnotations → handler → TM1Client → OData), plus the
// celldata view tools (get_view / get_view_definition).
//
// Scaffold: two dimensions + a cube live under the SANDBOX prefix. One D1
// element deliberately contains a single quote to exercise OData literal
// escaping in createNative's Elements@odata.bind path (the P1.1 fix) — the
// native-view create over that element MUST succeed.
//
// Everything created is SANDBOX-prefixed; afterAll tears it down idempotently.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const PFX = `${SANDBOX}_VIEW`;
const D1 = `${PFX}_D1`;
const D2 = `${PFX}_D2`;
const C1 = `${PFX}_C1`;

// Element with a single quote — the OData escaping canary.
const QUOTE_EL = "El'Quote";
const D1_ELEMENTS = ["E1", "E2", QUOTE_EL];
const D2_ELEMENTS = ["M1", "M2"];

const SUBSET = `${PFX}_SUB1`;
const NATIVE_VIEW = `${PFX}_NV1`;
const MDX_VIEW = `${PFX}_MV1`;

describe.skipIf(!LIVE_ENABLED)("live: view + subset lifecycle", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();

    // Clean any leftovers from a crashed prior run so create() calls don't 400.
    await h.call("tm1_delete_view", { cubeName: C1, viewName: NATIVE_VIEW });
    await h.call("tm1_delete_view", { cubeName: C1, viewName: MDX_VIEW });
    await h.call("tm1_delete_cube", { name: C1, confirm: C1 });
    await h.call("tm1_delete_dimension", { name: D1, confirm: D1 });
    await h.call("tm1_delete_dimension", { name: D2, confirm: D2 });

    // Scaffold: dims + elements + cube.
    await h.ok("tm1_create_dimension", { name: D1 });
    await h.ok("tm1_create_dimension", { name: D2 });
    for (const name of D1_ELEMENTS) {
      await h.ok("tm1_create_element", {
        dimensionName: D1,
        hierarchyName: D1,
        element: { name, type: "Numeric" },
      });
    }
    for (const name of D2_ELEMENTS) {
      await h.ok("tm1_create_element", {
        dimensionName: D2,
        hierarchyName: D2,
        element: { name, type: "Numeric" },
      });
    }
    await h.ok("tm1_create_cube", { name: C1, dimensions: [D1, D2] });
  });

  afterAll(async () => {
    const swallow = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch {
        /* already gone */
      }
    };
    await swallow(h.call("tm1_delete_view", { cubeName: C1, viewName: NATIVE_VIEW }));
    await swallow(h.call("tm1_delete_view", { cubeName: C1, viewName: MDX_VIEW }));
    await swallow(
      h.call("tm1_delete_subset", { dimensionName: D1, hierarchyName: D1, subsetName: SUBSET }),
    );
    await swallow(h.call("tm1_delete_cube", { name: C1, confirm: C1 }));
    await swallow(h.call("tm1_delete_dimension", { name: D1, confirm: D1 }));
    await swallow(h.call("tm1_delete_dimension", { name: D2, confirm: D2 }));
  });

  // ---- Subset lifecycle (static element-based) ----

  it("create_subset (static) creates a public subset on D1", async () => {
    const r = await h.ok("tm1_create_subset", {
      dimensionName: D1,
      hierarchyName: D1,
      subsetName: SUBSET,
      elements: ["E1", "E2"],
    });
    expect(r.json).toMatchObject({ success: true, kind: "static" });
  });

  it("get_subset returns the static members", async () => {
    const r = await h.ok("tm1_get_subset", {
      dimensionName: D1,
      hierarchyName: D1,
      subsetName: SUBSET,
    });
    expect(r.json.name).toBe(SUBSET);
    expect(r.json.elements).toEqual(expect.arrayContaining(["E1", "E2"]));
  });

  it("list_subsets shows the created subset", async () => {
    const r = await h.ok("tm1_list_subsets", {
      dimensionName: D1,
      hierarchyName: D1,
      fetchAll: true,
      format: "json",
    });
    const names = (r.json.items ?? []).map((s: any) => s.name);
    expect(names).toContain(SUBSET);
  });

  it("update_subset switches it to an MDX expression", async () => {
    // TM1 11.8 rejects PATCH-ing a new Elements list onto an already-static
    // subset ("both a list of Elements and an Expression"); the reliable
    // update path is to set an MDX expression, which also resolves the full
    // hierarchy (all 3 elements incl. the quote element).
    const u = await h.ok("tm1_update_subset", {
      dimensionName: D1,
      hierarchyName: D1,
      subsetName: SUBSET,
      expression: `{TM1SUBSETALL([${D1}])}`,
    });
    expect(u.json).toMatchObject({ success: true });

    const r = await h.ok("tm1_get_subset", {
      dimensionName: D1,
      hierarchyName: D1,
      subsetName: SUBSET,
    });
    expect(r.json.expression).toBeTruthy();
    // The dynamic set now resolves every D1 element, including the quote one.
    expect(r.json.elements).toEqual(expect.arrayContaining(["E1", "E2", QUOTE_EL]));
  });

  it("delete_subset removes it", async () => {
    const r = await h.ok("tm1_delete_subset", {
      dimensionName: D1,
      hierarchyName: D1,
      subsetName: SUBSET,
    });
    expect(r.json).toMatchObject({ success: true });
  });

  // ---- Native view (exercises OData quote-escaping on Elements@odata.bind) ----

  it("create_native_view over a quote-containing element succeeds (P1.1 escaping)", async () => {
    const r = await h.ok("tm1_create_native_view", {
      cubeName: C1,
      viewName: NATIVE_VIEW,
      // Rows reference the single-quote element via explicit element list →
      // Elements@odata.bind path. If OData escaping were wrong, TM1 would 400.
      rows: [{ dimension: D1, elements: [QUOTE_EL, "E1"] }],
      columns: [{ dimension: D2, elements: ["M1", "M2"] }],
    });
    expect(r.json).toMatchObject({ success: true, cubeName: C1, viewName: NATIVE_VIEW });
  });

  it("get_view executes the native view and returns cells + axes", async () => {
    const r = await h.ok("tm1_get_view", { cubeName: C1, viewName: NATIVE_VIEW });
    expect(r.json.cubeName).toBe(C1);
    expect(r.json.viewName).toBe(NATIVE_VIEW);
    expect(Array.isArray(r.json.cells)).toBe(true);
    expect(Array.isArray(r.json.axes)).toBe(true);
  });

  it("get_view_definition returns the native structure with columns + rows", async () => {
    const r = await h.ok("tm1_get_view_definition", {
      cubeName: C1,
      viewName: NATIVE_VIEW,
    });
    expect(r.json.type).toBe("Native");
    expect(r.json.native).toBeTruthy();
    expect(Array.isArray(r.json.native.columns)).toBe(true);
    expect(Array.isArray(r.json.native.rows)).toBe(true);
    expect(r.json.native.columns.length).toBeGreaterThanOrEqual(1);
    expect(r.json.native.rows.length).toBeGreaterThanOrEqual(1);
    // Dimension wiring round-trips through the NativeView expand.
    const dims = [
      ...r.json.native.columns.map((a: any) => a.dimensionName),
      ...r.json.native.rows.map((a: any) => a.dimensionName),
    ];
    expect(dims).toEqual(expect.arrayContaining([D1, D2]));
  });

  it("list_views shows the native view", async () => {
    const r = await h.ok("tm1_list_views", {
      cubeName: C1,
      fetchAll: true,
      format: "json",
    });
    const names = (r.json.items ?? []).map((v: any) => v.name);
    expect(names).toContain(NATIVE_VIEW);
  });

  it("delete_view removes the native view", async () => {
    const r = await h.ok("tm1_delete_view", { cubeName: C1, viewName: NATIVE_VIEW });
    expect(r.json).toMatchObject({ success: true });
  });

  // ---- MDX view ----

  it("create_mdx_view + get_view_definition reports type MDX, then delete", async () => {
    const mdx =
      `SELECT {[${D2}].[M1]} ON COLUMNS, {[${D1}].[E1]} ON ROWS FROM [${C1}]`;
    const c = await h.ok("tm1_create_mdx_view", {
      cubeName: C1,
      viewName: MDX_VIEW,
      mdx,
    });
    expect(c.json).toMatchObject({ success: true, viewName: MDX_VIEW });

    const def = await h.ok("tm1_get_view_definition", {
      cubeName: C1,
      viewName: MDX_VIEW,
    });
    expect(def.json.type).toBe("MDX");
    expect(typeof def.json.mdx).toBe("string");
    expect(def.json.mdx.length).toBeGreaterThan(0);

    const d = await h.ok("tm1_delete_view", { cubeName: C1, viewName: MDX_VIEW });
    expect(d.json).toMatchObject({ success: true });
  });

  // ---- Negative path ----

  it("get_view_definition on a nonexistent view returns an error envelope", async () => {
    const r = await h.call("tm1_get_view_definition", {
      cubeName: C1,
      viewName: `${PFX}_DOES_NOT_EXIST`,
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });
});
