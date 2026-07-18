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

  it("records a per-object fetch error without throwing", async () => {
    const m = await buildDatasourceMembership(
      { getViewDefinition: async () => { throw new Error("boom"); }, getSubset: noSubset as never },
      [{ name: "P", type: "TM1CubeView", sourceName: "C", view: "vX" }],
    );
    expect(m.byElement.size).toBe(0);
    expect(m.fetchErrors).toEqual([{ process: "P", object: "view C/vX", message: "boom" }]);
  });
});
