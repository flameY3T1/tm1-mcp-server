// Live lifecycle test for the DIMENSION / ELEMENT / ATTRIBUTE domain. Drives
// the real MCP tool layer against a running TM1 server through a full
// create → read → update → move → attribute → delete cycle. Every object is
// prefixed with SANDBOX so it can never collide with real model objects, and
// afterAll cascades a dimension delete so a mid-test failure still cleans up.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER (see harness.ts). Skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getHarness, LIVE_ENABLED, SANDBOX, type LiveHarness } from "./harness.js";

const DIM = `${SANDBOX}_DIM_A`;
const HIER = DIM; // default hierarchy shares the dimension name
const ALT_HIER = `${SANDBOX}_DIM_A_ALT`;
// Single-quote in the name exercises OData literal quote-escaping end-to-end.
const QUOTE_EL = `${SANDBOX}_DIM_A_X'Y`;
const NONEXISTENT = `${SANDBOX}_DIM_DOES_NOT_EXIST`;

const TOP = "Total"; // consolidated root
const SUB = "Region_North"; // intermediate consolidation
const LEAF1 = "City_A"; // leaf under SUB
const LEAF2 = "City_B"; // leaf created standalone, then moved under SUB
const LEAF3 = "City_C"; // leaf for attribute values
const TC = "TypeChangeLeaf"; // standalone leaf for the upsert idempotency / type-change test

describe.skipIf(!LIVE_ENABLED)("live: dimension / element / attribute lifecycle", () => {
  let h: LiveHarness;

  beforeAll(async () => {
    h = await getHarness();
    // Defensive: drop a stale sandbox dim from a crashed prior run.
    await h.call("tm1_delete_dimension", { name: DIM, confirm: DIM });
  });

  afterAll(async () => {
    // delete_dimension cascades all hierarchies + elements + attributes.
    try {
      await h.call("tm1_delete_dimension", { name: DIM, confirm: DIM });
    } catch {
      /* best-effort teardown */
    }
  });

  it("creates a dimension", async () => {
    const r = await h.ok("tm1_create_dimension", { name: DIM });
    expect(r.json).toMatchObject({ success: true, dimensionName: DIM });
  });

  it("creates leaf + consolidated elements", async () => {
    // Leaf first (single create path).
    await h.ok("tm1_create_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      element: { name: LEAF1, type: "Numeric" },
    });
    // Element whose name contains a single quote — OData escaping path.
    await h.ok("tm1_create_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      element: { name: QUOTE_EL, type: "Numeric" },
    });
    // Consolidation rolling up LEAF1 (component must already exist).
    await h.ok("tm1_create_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      element: {
        name: SUB,
        type: "Consolidated",
        components: [{ name: LEAF1, weight: 1 }],
      },
    });
  });

  it("bulk-upserts more elements (leafs before consolidation)", async () => {
    const r = await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      hierarchy: HIER,
      elements: [
        { name: LEAF2, type: "Numeric" },
        { name: LEAF3, type: "Numeric" },
        {
          name: TOP,
          type: "Consolidated",
          components: [{ name: SUB, weight: 1 }],
        },
      ],
    });
    expect(r.json).toMatchObject({ success: true, total: 3 });
  });

  it("bulk-upsert is idempotent and surfaces in-place type changes", async () => {
    // Create a standalone leaf.
    const a = await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      hierarchy: HIER,
      elements: [{ name: TC, type: "Numeric" }],
    });
    expect(a.json).toMatchObject({ success: true });
    expect(a.json.typeChanges ?? []).toEqual([]);

    // Re-upsert with the SAME type must be idempotent. Regression: TM1 v11
    // reports "element already exists" as HTTP 400 (not 409), which used to
    // escape the conflict handler and throw.
    const b = await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      hierarchy: HIER,
      elements: [{ name: TC, type: "Numeric" }],
    });
    expect(b.json).toMatchObject({ success: true });
    expect(b.json.typeChanges ?? []).toEqual([]);

    // Changing the type in place must be reported (it discards leaf data).
    const c = await h.ok("tm1_bulk_upsert_elements", {
      dimensionName: DIM,
      hierarchy: HIER,
      elements: [{ name: TC, type: "String" }],
    });
    expect(c.json.typeChanges).toEqual([{ name: TC, from: "Numeric", to: "String" }]);
    expect(typeof c.json.warning).toBe("string");
  });

  it("get_hierarchy returns the created elements (incl. quoted name)", async () => {
    const r = await h.ok("tm1_get_hierarchy", { dimensionName: DIM, hierarchyName: HIER });
    expect(Array.isArray(r.json.elements)).toBe(true);
    const names: string[] = r.json.elements.map((e: { name: string }) => e.name);
    expect(names).toContain(LEAF1);
    expect(names).toContain(QUOTE_EL);
    expect(names).toContain(SUB);
    expect(names).toContain(TOP);
  });

  it("moves a standalone leaf under SUB", async () => {
    const r = await h.ok("tm1_move_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: LEAF2,
      newParent: SUB,
      weight: 1,
    });
    expect(r.json).toMatchObject({ success: true, elementName: LEAF2, newParent: SUB });
  });

  it("get_descendants returns the subtree under SUB", async () => {
    const r = await h.ok("tm1_get_descendants", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: SUB,
    });
    const names: string[] = r.json.descendants.map((d: { name: string }) => d.name);
    expect(names).toContain(LEAF1);
    expect(names).toContain(LEAF2); // the moved element now rolls up under SUB
  });

  it("get_descendants leavesOnly drops consolidations", async () => {
    const r = await h.ok("tm1_get_descendants", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: TOP,
      leavesOnly: true,
    });
    const types: string[] = r.json.descendants.map((d: { type: string }) => d.type);
    expect(types.length).toBeGreaterThan(0);
    expect(types).not.toContain("Consolidated");
  });

  it("get_ancestors walks the roll-up path from a leaf", async () => {
    const r = await h.ok("tm1_get_ancestors", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: LEAF1,
    });
    const names: string[] = r.json.ancestors.map((a: { name: string }) => a.name);
    expect(names).toContain(SUB);
    expect(names).toContain(TOP);
  });

  it("updates a consolidation's components", async () => {
    // Element rename via OData PATCH(Name) is a no-op in TM1; the supported
    // mutation through this path is changing a consolidation's Components.
    // Add LEAF3 directly under SUB and verify it becomes a descendant.
    await h.ok("tm1_update_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: SUB,
      update: {
        type: "Consolidated",
        components: [
          { name: LEAF1, weight: 1 },
          { name: LEAF2, weight: 1 },
          { name: LEAF3, weight: 1 },
        ],
      },
    });
    const r = await h.ok("tm1_get_descendants", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: SUB,
    });
    const names: string[] = r.json.descendants.map((d: { name: string }) => d.name);
    expect(names).toContain(LEAF3);
  });

  it("find_orphan_dimensions lists our unused dimension", async () => {
    // Must run BEFORE attribute creation: creating an element attribute spawns
    // a }ElementAttributes_{DIM} control cube that references DIM, which would
    // make DIM count as "used" and drop it from the orphan set.
    const r = await h.ok("tm1_find_orphan_dimensions", { fetchAll: true });
    const names: string[] = r.json.items.map((o: { name: string }) => o.name);
    expect(names).toContain(DIM);
  });

  it("creates an alternate hierarchy", async () => {
    const r = await h.ok("tm1_create_hierarchy", {
      dimensionName: DIM,
      hierarchyName: ALT_HIER,
    });
    expect(r.json).toMatchObject({ success: true, hierarchyName: ALT_HIER });
  });

  it("resolves a single default member via the bulk tool (1-item array)", async () => {
    const r = await h.ok("tm1_resolve_default_members", { items: [{ dimensionName: DIM }] });
    expect(r.json.results.length).toBe(1);
    expect(r.json.results[0]).toHaveProperty("source");
    expect(r.json.results[0]).toHaveProperty("confidence");
  });

  it("bulk-resolves default members", async () => {
    const r = await h.ok("tm1_resolve_default_members", {
      items: [{ dimensionName: DIM }, { dimensionName: DIM, hierarchyName: ALT_HIER }],
    });
    expect(Array.isArray(r.json.results)).toBe(true);
    expect(r.json.results.length).toBe(2);
  });

  it("creates string + numeric attributes and lists them", async () => {
    await h.ok("tm1_create_element_attribute", {
      dimensionName: DIM,
      hierarchyName: HIER,
      attributeName: "Caption",
      attributeType: "String",
    });
    await h.ok("tm1_create_element_attribute", {
      dimensionName: DIM,
      hierarchyName: HIER,
      attributeName: "SortOrder",
      attributeType: "Numeric",
    });
    const r = await h.ok("tm1_list_element_attributes", {
      dimensionName: DIM,
      hierarchyName: HIER,
      fetchAll: true,
    });
    const names: string[] = r.json.items.map((a: { name: string }) => a.name);
    expect(names).toContain("Caption");
    expect(names).toContain("SortOrder");
  });

  it("sets and reads back attribute values", async () => {
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: DIM,
      elementName: LEAF1,
      attributeName: "Caption",
      value: "North City A",
    });
    await h.ok("tm1_update_element_attribute_value", {
      dimensionName: DIM,
      elementName: LEAF1,
      attributeName: "SortOrder",
      value: 42,
    });
    const r = await h.ok("tm1_get_element_attribute_values", {
      dimensionName: DIM,
      elementName: LEAF1,
    });
    const byName = new Map<string, unknown>(
      r.json.attributes.map((a: { attributeName: string; value: unknown }) => [
        a.attributeName,
        a.value,
      ]),
    );
    expect(String(byName.get("Caption"))).toBe("North City A");
    expect(Number(byName.get("SortOrder"))).toBe(42);
  });

  it("deletes an element", async () => {
    await h.ok("tm1_delete_element", {
      dimensionName: DIM,
      hierarchyName: HIER,
      elementName: QUOTE_EL,
      confirm: QUOTE_EL,
    });
    const r = await h.ok("tm1_get_hierarchy", { dimensionName: DIM, hierarchyName: HIER });
    const names: string[] = r.json.elements.map((e: { name: string }) => e.name);
    expect(names).not.toContain(QUOTE_EL);
  });

  it("deletes the alternate hierarchy", async () => {
    const r = await h.ok("tm1_delete_hierarchy", {
      dimensionName: DIM,
      hierarchyName: ALT_HIER,
      confirm: ALT_HIER,
    });
    expect(r.json).toMatchObject({ success: true, hierarchyName: ALT_HIER });
  });

  // ── Negative path ──────────────────────────────────────────────────────
  it("get_hierarchy on a nonexistent dimension errors with a code", async () => {
    const r = await h.call("tm1_get_hierarchy", {
      dimensionName: NONEXISTENT,
      hierarchyName: NONEXISTENT,
    });
    expect(r.isError).toBe(true);
    expect(r.json?.code).toBeTruthy();
  });

  it("deletes the dimension (cascade)", async () => {
    const r = await h.ok("tm1_delete_dimension", { name: DIM, confirm: DIM });
    expect(r.json).toMatchObject({ success: true, dimensionName: DIM });
  });
});
