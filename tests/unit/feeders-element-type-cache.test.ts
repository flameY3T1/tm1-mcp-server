import { describe, it, expect, vi } from "vitest";
import { ElementTypeCache } from "../../src/lib/feeders/element-type-cache.js";

interface HierarchyMock {
  getElementTypes: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function makeHierarchyMock(
  map: Record<string, Array<{ name: string; type: string }>>,
): HierarchyMock {
  return {
    getElementTypes: vi.fn(async (dim: string, hier: string) => {
      const key = `${dim}|${hier}`;
      return (map[key] ?? []).map((e) => ({ name: e.name, type: e.type }));
    }),
    // The full-hierarchy read must never be used for a type lookup — it
    // expands Parents and scans Edges.
    get: vi.fn(async () => {
      throw new Error("hierarchy.get() must not be called for type lookups");
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

    expect(await cache.getType("Region", "Region", "Total")).toBe(
      "Consolidated",
    );
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
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
  });

  it("uses the narrow Name,Type read, not the full hierarchy expand", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "DE", type: "Numeric" }],
    });
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledWith("Region", "Region");
    expect(hier.get).not.toHaveBeenCalled();
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
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not throw when hierarchy fetch fails", async () => {
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        throw new Error("hier 404");
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Bogus", "Bogus", "X")).toBeNull();
  });

  it("does not cache a failed load — a later call retries and can succeed", async () => {
    let calls = 0;
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("transient timeout");
        return [{ name: "DE", type: "Numeric" }];
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(2);

    // …and the successful load is cached from then on.
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share a single failing load attempt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        await gate;
        throw new Error("hier 500");
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    const inflight = Promise.all([
      cache.getType("Region", "Region", "DE"),
      cache.getType("Region", "Region", "FR"),
      cache.getType("region", "region", "IT"),
    ]);
    release();
    expect(await inflight).toEqual([null, null, null]);
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 consecutive failures and stops issuing requests", async () => {
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        // Deterministic failure, e.g. TM1's HTTP 400 ObjectSecurityNoReadRights
        // for a dimension the auditing user may not read.
        throw new Error("ObjectSecurityNoReadRights");
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    // Failures 1 and 2 each retry.
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(2);

    // The 3rd failure pins the slot to null.
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);

    // No further requests, however many lookups follow — this is the bound
    // that keeps a per-feeder-entry loop from issuing N failing calls.
    for (let i = 0; i < 25; i++) {
      expect(await cache.getType("Region", "Region", `E${i}`)).toBeNull();
    }
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
  });

  it("spends the retry budget before the threshold and still heals on the last attempt", async () => {
    let calls = 0;
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return [{ name: "DE", type: "Numeric" }];
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    // Attempt 3 succeeds: the slot must be cached as the success, never pinned
    // to null by the two failures that preceded it.
    expect(await cache.getType("Region", "Region", "DE")).toBe("Numeric");
    expect(await cache.getType("Region", "Region", "FR")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
  });

  it("counts failures per slot — one dead dimension does not pin the others", async () => {
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async (dim: string) => {
        if (dim === "Region") throw new Error("ObjectSecurityNoReadRights");
        return [{ name: "P1", type: "Numeric" }];
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    for (let i = 0; i < 5; i++) {
      expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    }
    // Region pinned after 3; Product unaffected and still resolvable.
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
    expect(await cache.getType("Product", "Product", "P1")).toBe("Numeric");
    expect(hier.getElementTypes).toHaveBeenCalledTimes(4);
  });

  it("counts a shared failing attempt as one failure, not one per caller", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const hier: HierarchyMock = {
      getElementTypes: vi.fn(async () => {
        if (first) {
          first = false;
          await gate;
        }
        throw new Error("hier 500");
      }),
      get: vi.fn(),
    };
    const cache = new ElementTypeCache(hier as never);

    const inflight = Promise.all([
      cache.getType("Region", "Region", "DE"),
      cache.getType("Region", "Region", "FR"),
      cache.getType("Region", "Region", "IT"),
      cache.getType("Region", "Region", "ES"),
    ]);
    release();
    expect(await inflight).toEqual([null, null, null, null]);
    // One shared attempt → one failure counted, so the budget is not burned
    // by the number of waiting callers.
    expect(hier.getElementTypes).toHaveBeenCalledTimes(1);

    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
    // Third failure pinned it.
    expect(await cache.getType("Region", "Region", "DE")).toBeNull();
    expect(hier.getElementTypes).toHaveBeenCalledTimes(3);
  });

  it("normalizes type strings unknown to TM1 to null", async () => {
    const hier = makeHierarchyMock({
      "Region|Region": [{ name: "Weird", type: "SomethingElse" }],
    });
    const cache = new ElementTypeCache(hier as never);
    expect(await cache.getType("Region", "Region", "Weird")).toBeNull();
  });
});
