import { describe, it, expect } from "vitest";
import { buildDatasourceMembership } from "../../src/lib/callgraph/datasourceMembership.js";
import { elementKey } from "../../src/lib/callgraph/referenceIndex.js";

const noView = async () => { throw new Error("no view"); };
const noSubset = async () => { throw new Error("no subset"); };

describe("buildDatasourceMembership", () => {
  it("resolves a static subset datasource to exact elements", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: noView as never,
        getSubset: async (dim: string, _h: string, sub: string) => ({
          name: sub, dimensionName: dim, hierarchyName: dim, private: false,
          expression: undefined, elements: ["SuDatenquellen_C", "SuDatenquellen_D"], alias: undefined,
        }),
      },
      [{ name: "P", type: "TM1DimensionSubset", sourceName: "Datenquellen", subset: "sMy" }],
    );
    expect(m.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"))).toEqual([
      { process: "P", via: "subset-static" },
    ]);
  });

  it("resolves an MDX view datasource to literal members + flags computed selectors", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "MDX" as const,
          mdx: "{ TM1FILTERBYLEVEL(TM1SUBSETALL([Zeit]),0) } * { [Datenquellen].[SuDatenquellen_C] }",
        }),
        getSubset: noSubset as never,
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "ZusaetzlicheFahrten", view: "vMy" }],
    );
    expect(m.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"))).toEqual([
      { process: "P", via: "view-mdx" },
    ]);
    expect([...(m.computedByProcess.get("P") ?? [])].sort()).toEqual(["TM1FILTERBYLEVEL", "TM1SUBSETALL"]);
  });

  it("resolves a native view title's selectedElement exactly", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: {
            titles: [{ dimensionName: "Szenario", selectedElement: "Ist" }],
            columns: [], rows: [],
          },
        }),
        getSubset: noSubset as never,
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vT" }],
    );
    expect(m.byElement.get(elementKey("Szenario", "Ist"))).toEqual([
      { process: "P", via: "view-native-title" },
    ]);
  });

  it("does not enumerate a title's underlying subset — only the selected member is reported", async () => {
    let getSubsetCalled = false;
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: {
            titles: [{ dimensionName: "Szenario", selectedElement: "Ist", subsetName: "sScenario" }],
            columns: [], rows: [],
          },
        }),
        getSubset: async (dim: string, _h: string, sub: string) => {
          getSubsetCalled = true;
          return {
            name: sub, dimensionName: dim, hierarchyName: dim, private: false,
            expression: undefined, elements: ["Ist", "Plan", "Forecast"], alias: undefined,
          };
        },
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vT" }],
    );
    expect(m.byElement.get(elementKey("Szenario", "Ist"))).toEqual([
      { process: "P", via: "view-native-title" },
    ]);
    expect(m.byElement.get(elementKey("Szenario", "Plan"))).toBeUndefined();
    expect(getSubsetCalled).toBe(false);
  });

  it("records a per-object fetch error without throwing", async () => {
    const m = await buildDatasourceMembership(
      { getViewDefinition: async () => { throw new Error("boom"); }, getSubset: noSubset as never },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vX" }],
    );
    expect(m.byElement.size).toBe(0);
    expect(m.fetchErrors).toEqual([{ process: "P", object: "view C/vX", message: "boom" }]);
  });
});

describe("buildDatasourceMembership — computed axis resolution (C1)", () => {
  it("resolves a computed native-axis expression via evaluateSetExpression", async () => {
    const calls: Array<{ cube: string; dim: string; set: string }> = [];
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: {
            titles: [],
            columns: [],
            rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }],
          },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        evaluateSetExpression: async (cube: string, dim: string, set: string) => {
          calls.push({ cube, dim, set });
          return ["EUR", "CHF", "USD", "Group_EUR"];
        },
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "Cube_Assumptions", view: "vC" }],
    );
    expect(m.byElement.get(elementKey("Currency", "USD"))).toEqual([{ process: "P", via: "view-native-computed" }]);
    expect(calls).toEqual([{ cube: "Cube_Assumptions", dim: "Currency", set: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }]);
    // computed selector still recorded (honest provenance) even though resolved
    expect([...(m.computedByProcess.get("P") ?? [])]).toContain("TM1FILTERBYLEVEL");
  });

  it("without evaluateSetExpression, a computed axis stays flagged (no members)", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: { titles: [], columns: [], rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{TM1FILTERBYLEVEL({TM1SUBSETALL([Currency])},0)}" }] },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        // no evaluateSetExpression
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vC" }],
    );
    expect(m.byElement.get(elementKey("Currency", "USD"))).toBeUndefined();
    expect([...(m.computedByProcess.get("P") ?? [])]).toContain("TM1FILTERBYLEVEL");
  });

  it("eval failure is recorded in fetchErrors and does not throw", async () => {
    const m = await buildDatasourceMembership(
      {
        getViewDefinition: async (cube: string, view: string) => ({
          cubeName: cube, viewName: view, private: false, type: "Native" as const,
          native: { titles: [], columns: [], rows: [{ dimensionName: "Currency", hierarchyName: "Currency", expression: "{DESCENDANTS([Currency])}" }] },
        }),
        getSubset: (async () => { throw new Error("n/a"); }) as never,
        evaluateSetExpression: async () => { throw new Error("bad mdx"); },
      },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vC" }],
    );
    expect(m.byElement.size).toBe(0);
    expect(m.fetchErrors.some((e) => e.process === "P" && /eval/i.test(e.object))).toBe(true);
  });
});
