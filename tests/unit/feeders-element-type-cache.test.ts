import { describe, it, expect, vi } from "vitest";
import { ElementTypeCache } from "../../src/lib/feeders/element-type-cache.js";

interface HierarchyMock {
  get: ReturnType<typeof vi.fn>;
}

function makeHierarchyMock(map: Record<string, Array<{ name: string; type: string }>>): HierarchyMock {
  return {
    get: vi.fn(async (dim: string, hier: string) => {
      const key = `${dim}|${hier}`;
      const elements = map[key] ?? [];
      return {
        name: hier,
        dimensionName: dim,
        elements: elements.map((e) => ({
          name: e.name,
          type: e.type,
          level: 0,
          parents: [],
          children: [],
        })),
      };
    }),
  };
}

describe("ElementTypeCache", () => {
  it("returns element type via hierarchy fetch", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [
        { name: "Total", type: "Consolidated" },
        { name: "DE", type: "Numeric" },
      ],
    });
    const cache = new ElementTypeCache(hier as never);

    expect(await cache.getType("Region", "Region", "Total")).toBe("Consolidated");
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
  });

  it("returns null for unknown elements", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Region", "Region", "ZZ")).toBeNull();
  });

  it("caches (dim, hier) — only one REST call per pair", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier as never);
    await cache.getType("Region", "Region", "DE");
    await cache.getType("Region", "Region", "DE");
    await cache.getType("Region", "Region", "FR");
    expect(hier.get).toHaveBeenCalledTimes(1);
  });

  it("element names case-insensitive on lookup (TM1 semantics)", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Region", "Region", "de")).toBe("Numeric");
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
  });

  it("dim/hier names case-insensitive — same underlying cache slot", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier as never);
    await cache.getType("region", "REGION", "DE");
    await cache.getType("Region", "Region", "DE");
    expect(hier.get).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not throw when hierarchy fetch fails", async () => {
    const hier: HierarchyMock = {
      get: vi.fn(async () => {
        throw new Error("hier 404");
      }),
    };
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Bogus", "Bogus", "X")).toBeNull();
  });

  it("does not retry the same failing (dim, hier) — negative result cached", async () => {
    const hier: HierarchyMock = {
      get: vi.fn(async () => {
        throw new Error("hier 404");
      }),
    };
    const cache = new ElementTypeCache(hier as never);
    await cache.getType("Bogus", "Bogus", "X");
    await cache.getType("Bogus", "Bogus", "Y");
    expect(hier.get).toHaveBeenCalledTimes(1);
  });

  it("normalizes type strings unknown to TM1 to null", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "Weird", type: "SomethingElse" }],
    });
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Region", "Region", "Weird")).toBeNull();
  });
});
