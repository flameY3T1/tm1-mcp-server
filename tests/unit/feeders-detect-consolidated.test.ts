import { describe, it, expect, vi } from "vitest";
import { detectFeederToConsolidated } from "../../src/lib/feeders/static-heuristics.js";
import { parseBracketList } from "../../src/lib/feeders/brackets.js";
import { ElementTypeCache } from "../../src/lib/feeders/element-type-cache.js";

function lhs(text: string) {
  const r = parseBracketList(text);
  if (!r) throw new Error(`parse failed: ${text}`);
  return r;
}

function makeCache(
  table: Record<string, Record<string, "Numeric" | "Consolidated" | "String">>,
): ElementTypeCache {
  const hier = {
    get: vi.fn(async (dim: string, hierName: string) => {
      const key = `${dim}|${hierName}`;
      const elems = table[key] ?? {};
      return {
        name: hierName,
        dimensionName: dim,
        elements: Object.entries(elems).map(([name, type]) => ({
          name,
          type,
          level: 0,
          parents: [],
          children: [],
        })),
      };
    }),
  };
  return new ElementTypeCache(hier as never);
}

describe("detectFeederToConsolidated — S2", () => {
  it("flags positional feeder with consolidated element", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated", DE: "Numeric" },
      "Time|Time": { "2026": "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total','2026']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("does not flag positional feeder when all elements are leaves", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric" },
      "Time|Time": { "2026": "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['DE','2026']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toBeNull();
  });

  it("flags qualified feeder with consolidated element", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region':'Total']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("flags set-form feeder when any element is consolidated", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric", Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region':{'DE','Total'}]"),
      ["Region"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns null on empty bracket (S4 territory)", async () => {
    const cache = makeCache({});
    expect(
      await detectFeederToConsolidated(lhs("[]"), ["Region"], cache),
    ).toBeNull();
  });

  it("returns null when cubeDimNames is empty (resolver missing)", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total']"),
      [],
      cache,
    );
    expect(result).toBeNull();
  });

  it("skips positional entries past cubeDimNames length", async () => {
    const cache = makeCache({
      "Region|Region": { DE: "Numeric" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['DE','SomethingExtra']"),
      ["Region"],
      cache,
    );
    expect(result).toBeNull();
  });

  it("handles 'Dim:Hier' qualified form", async () => {
    const cache = makeCache({
      "Region|RegionAlt": { Total: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Region:RegionAlt':'Total']"),
      ["Region"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns first consolidated element on multi-flag rows", async () => {
    const cache = makeCache({
      "Region|Region": { Total: "Consolidated" },
      "Time|Time": { Y: "Consolidated" },
    });
    const result = await detectFeederToConsolidated(
      lhs("['Total','Y']"),
      ["Region", "Time"],
      cache,
    );
    expect(result).toEqual({ dim: "Region", elem: "Total" });
  });

  it("returns null when element-type lookup fails (degrade gracefully)", async () => {
    const cache = makeCache({});
    const result = await detectFeederToConsolidated(
      lhs("['Total']"),
      ["Region"],
      cache,
    );
    expect(result).toBeNull();
  });
});
