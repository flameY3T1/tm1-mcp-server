import { describe, it, expect } from "vitest";
import { traceDataFlow, type DataSourceEntry } from "../../src/lib/callgraph/dataFlow.js";
import { buildReferenceIndex, elementKey } from "../../src/lib/callgraph/referenceIndex.js";
import { buildDatasourceMembership } from "../../src/lib/callgraph/datasourceMembership.js";
import type { ReferenceIndex, TmReference } from "../../src/lib/callgraph/referenceIndex.js";
import type { DatasourceMembership } from "../../src/lib/callgraph/datasourceMembership.js";

function ref(sourceName: string, funcName: string, targetName: string): TmReference {
  return {
    sourceKind: "process",
    sourceName,
    section: "data",
    line: 1,
    snippet: "",
    funcName,
    targetKind: "cube",
    targetName,
  };
}

function index(refs: TmReference[]): ReferenceIndex {
  return {
    all: refs,
    byCube: new Map(),
    byDim: new Map(),
    byProcess: new Map(),
    bySourceProcess: new Map(),
    unresolvedCallsBySourceProcess: new Map(),
    processParams: new Map(),
    processDefaults: new Map(),
    choreTasks: new Map(),
  };
}

describe("traceDataFlow", () => {
  it("downstream: a reader's write targets, excluding the cube itself", () => {
    const idx = index([
      ref("TransferP", "CellGetN", "Sales"),
      ref("TransferP", "CellPutN", "Margin"),
      ref("TransferP", "CellPutN", "Sales"), // self-write should not appear as a target
    ]);
    const r = traceDataFlow(idx, [], "Sales", "downstream");
    expect(r.downstream).toEqual([{ process: "TransferP", targetCubes: ["Margin"], readsVia: "code" }]);
    expect(r.upstream).toBeUndefined();
    expect(r.counts.downstream).toBe(1);
  });

  it("upstream: a writer's source cubes + datasource type", () => {
    const idx = index([
      ref("TransferP", "CellGetN", "Sales"),
      ref("TransferP", "CellPutN", "Margin"),
    ]);
    const ds: DataSourceEntry[] = [{ name: "TransferP", type: "TM1CubeView", sourceName: "Sales", view: "v1" }];
    const r = traceDataFlow(idx, ds, "Margin", "upstream");
    expect(r.upstream).toEqual([
      { process: "TransferP", sourceCubes: ["Sales"], datasourceType: "TM1CubeView" },
    ]);
    expect(r.counts.upstream).toBe(1);
  });

  it("catches a view-sourced reader that has no CellGet in code (datasource pass)", () => {
    const idx = index([ref("LoadX", "CellPutN", "Report")]); // no read ref to Sales
    const ds: DataSourceEntry[] = [{ name: "LoadX", type: "TM1CubeView", sourceName: "Sales" }];
    const r = traceDataFlow(idx, ds, "Sales", "downstream");
    expect(r.downstream).toEqual([{ process: "LoadX", targetCubes: ["Report"], readsVia: "datasource" }]);
  });

  it("marks readsVia=both when a process reads via code and datasource", () => {
    const idx = index([ref("P", "CellGetN", "Sales"), ref("P", "CellPutN", "Out")]);
    const ds: DataSourceEntry[] = [{ name: "P", type: "TM1CubeView", sourceName: "Sales" }];
    const r = traceDataFlow(idx, ds, "Sales", "downstream");
    expect(r.downstream?.[0]?.readsVia).toBe("both");
  });

  it("reports an external (ASCII) datasource for a writer", () => {
    const idx = index([ref("LoadAscii", "CellPutN", "Sales")]);
    const ds: DataSourceEntry[] = [{ name: "LoadAscii", type: "ASCII" }];
    const r = traceDataFlow(idx, ds, "Sales", "upstream");
    expect(r.upstream).toEqual([
      { process: "LoadAscii", sourceCubes: [], datasourceType: "ASCII", externalSource: "ASCII file" },
    ]);
  });

  it("matches cube name case-insensitively and preserves original casing", () => {
    const idx = index([ref("P", "CellGetN", "Sales"), ref("P", "CellPutN", "Margin")]);
    const r = traceDataFlow(idx, [], "sALES", "both");
    expect(r.cube).toBe("Sales");
    expect(r.downstream).toHaveLength(1);
  });

  it("direction=both returns both lists", () => {
    const idx = index([ref("A", "CellGetN", "C"), ref("A", "CellPutN", "X"), ref("B", "CellPutN", "C")]);
    const r = traceDataFlow(idx, [], "C", "both");
    expect(r.counts).toEqual({ upstream: 1, downstream: 1 });
    expect(r.downstream?.[0]?.process).toBe("A");
    expect(r.upstream?.[0]?.process).toBe("B");
  });

  it("ignores 'other' (structural) cube refs", () => {
    const idx = index([ref("P", "ViewExtractSkipZeroesSet", "Sales")]);
    const r = traceDataFlow(idx, [], "Sales", "both");
    expect(r.counts).toEqual({ upstream: 0, downstream: 0 });
  });
});

describe("traceDataFlow — per-row elements", () => {
  it("carries a process's in-code subset-membership elements onto its downstream reader row", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        {
          name: "TransferP",
          prolog: "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);",
          metadata: "",
          data: "nV = CellGetN('Sales', 'E1');",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const flow = traceDataFlow(index, [], "Sales", "downstream");
    expect(flow.downstream).toEqual([
      { process: "TransferP", targetCubes: [], readsVia: "code", elements: ["SuDatenquellen_C"] },
    ]);
  });
});

describe("traceDataFlow — element filter", () => {
  it("lists processes that touch a given element of a dimension", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "Builder", prolog: "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    // sTmp is built but never assigned to a view / iterated → indeterminate, which is
    // filtered out by default; opt in to see it.
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Datenquellen", name: "SuDatenquellen_C" },
      elementAccess: ["source", "write", "zero-out", "indeterminate"],
    });
    expect(flow.element).toEqual({
      dimension: "Datenquellen",
      name: "SuDatenquellen_C",
      processes: [{ process: "Builder", funcNames: ["SubsetElementInsert"], access: ["indeterminate"] }],
      resolution:
        "access from in-code subset usage (view-assign/zero-out/loop) + datasource; stored view/subset datasources resolved (native-title/static exact, MDX by literal member); computed selectors (TM1FILTERBY*/DESCENDANTS/…) flagged in computedInProcesses, not resolved; 'indeterminate' = built but not classifiable, not evidence the element goes untouched.",
    });
  });

  it("surfaces a process with a non-literal element arg (known dimension) as unresolvedInProcesses", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        {
          name: "DynamicElemProc",
          prolog: "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Kunde", name: "Whatever" },
    });
    // unresolvedElementRefsBySourceProcess is keyed lowercased (existing referenceIndex behavior).
    expect(flow.element?.unresolvedInProcesses).toContain("dynamicelemproc");
  });

  it("excludes a process's unresolved element arg from unresolvedInProcesses when it's on a different dimension", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        {
          // Unresolved arg is on dimension "Kunde" — tracing an element of "Region" must not
          // surface this process, exercising the dimension filter at the unresolvedInProcesses build.
          name: "DynamicElemProc",
          prolog: "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Region", name: "EMEA" },
    });
    expect(flow.element?.unresolvedInProcesses).toBeUndefined();
  });
});

describe("traceDataFlow — element access classification", () => {
  async function idx(prolog: string) {
    return buildReferenceIndex({
      fetchProcesses: async () => [{ name: "P", prolog, metadata: "", data: "", epilog: "", parameters: [] }],
      fetchCubesWithRules: async () => [], fetchChores: async () => [],
    });
  }
  it("tags zero-out when the element's subset feeds a ViewZeroOut", async () => {
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','vTmp','Currency','sTmp');\nViewZeroOut('Sales','vTmp');",
    );
    const flow = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out"] });
    expect(flow.element!.processes).toEqual([{ process: "P", funcNames: ["SubsetElementInsert"], access: ["zero-out"] }]);
  });
  it("tags source when the element's subset feeds the process view datasource", async () => {
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','vTmp','Currency','sTmp');",
    );
    const ds = [{ name: "P", type: "TM1CubeView", sourceName: "Sales", view: "vTmp" }];
    const flow = traceDataFlow(index, ds, "Sales", "both",
      { element: { dimension: "Currency", name: "USD" } });
    expect(flow.element!.processes[0]!.access).toEqual(["source"]);
  });
  it("indeterminate is opt-in and counted when suppressed", async () => {
    const index = await idx("SubsetElementInsert('Currency','sTmp','USD',1);"); // built, never used
    const flow = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" } }); // default excludes indeterminate
    expect(flow.element!.processes).toEqual([]);
    expect(flow.element!.suppressedIndeterminate).toBe(1);
    const flow2 = traceDataFlow(index, [], "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out","indeterminate"] });
    expect(flow2.element!.processes[0]!.access).toEqual(["indeterminate"]);
  });
  it("does not tag source when a same-named subset handle belongs to a different dimension's datasource", async () => {
    // Generic temp-subset name "sTmp" is reused across dimensions in one process; the datasource's
    // subset happens to share the name but lives on a different dimension (Other, not Currency).
    const index = await idx("SubsetElementInsert('Currency','sTmp','USD',1);");
    const ds = [{ name: "P", type: "TM1DimensionSubset", sourceName: "Other", subset: "sTmp" }];
    const flow = traceDataFlow(index, ds, "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out","indeterminate"] });
    expect(flow.element!.processes[0]!.access).not.toContain("source");
    expect(flow.element!.processes[0]!.access).toEqual(["indeterminate"]);
  });
  it("tags write (not zero-out) for a loop write with a non-literal CellPutN value", async () => {
    // Same shape as the loopWrite/loopZero unit in subset-usage.test.ts: SubsetGetElementName
    // feeds a variable-value CellPutN (not a literal 0), so loopWrite=true and loopZero=false —
    // the only path that produces the "write" AccessKind (every other test's CellPutN is literal-0).
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nsEl=SubsetGetElementName('sTmp','Currency',1);\nCellPutN(pValue,'Sales',sEl);",
    );
    const flow = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Currency", name: "USD" },
    });
    expect(flow.element!.processes).toEqual([
      { process: "P", funcNames: ["SubsetElementInsert"], access: ["write"] },
    ]);
  });

  it("tags source via a direct TM1DimensionSubset match (in-code subset === datasource subset, on the traced dimension)", async () => {
    const index = await idx("SubsetElementInsert('Kunde','sMy','C001',1);");
    const ds: DataSourceEntry[] = [{ name: "P", type: "TM1DimensionSubset", sourceName: "Kunde", subset: "sMy" }];
    const flow = traceDataFlow(index, ds, "AnyCube", "both", {
      element: { dimension: "Kunde", name: "C001" },
    });
    expect(flow.element!.processes).toEqual([
      { process: "P", funcNames: ["SubsetElementInsert"], access: ["source"] },
    ]);
  });

  it("does not tag source when a same-named view belongs to a different cube's datasource", async () => {
    // View name "Default" is reused across cubes; the process assigns the element's subset to
    // view "Default" of cube Sales, but the process datasource is view "Default" of cube Other.
    const index = await idx(
      "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','Default','Currency','sTmp');",
    );
    const ds = [{ name: "P", type: "TM1CubeView", sourceName: "Other", view: "Default" }];
    const flow = traceDataFlow(index, ds, "Sales", "both",
      { element: { dimension: "Currency", name: "USD" }, elementAccess: ["source","write","zero-out","indeterminate"] });
    expect(flow.element!.processes[0]!.access).not.toContain("source");
    expect(flow.element!.processes[0]!.access).toEqual(["indeterminate"]);
  });
});

describe("traceDataFlow — element filter incl. datasource membership", () => {
  it("merges a static-subset datasource reader into element.processes with a via tag", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "Reader", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const membership = await buildDatasourceMembership(
      {
        getViewDefinition: async () => { throw new Error("n/a"); },
        getSubset: async (dim: string, _h: string, sub: string) => ({
          name: sub, dimensionName: dim, hierarchyName: dim, private: false,
          expression: undefined, elements: ["SuDatenquellen_C"], alias: undefined,
        }),
      },
      [{ name: "Reader", type: "TM1DimensionSubset", sourceName: "Datenquellen", subset: "sMy" }],
    );
    const flow = traceDataFlow(index, [], "AnyCube", "both", {
      element: { dimension: "Datenquellen", name: "SuDatenquellen_C" },
      datasourceMembership: membership,
    });
    // A stored-subset datasource hit is a read → access ['source'] PLUS a via tag.
    expect(flow.element!.processes).toEqual([
      { process: "Reader", funcNames: [], access: ["source"], via: ["subset-static"] },
    ]);
  });

  it("surfaces a fetchErrors note in element.resolution when a stored view/subset could not be fetched", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        {
          name: "P",
          prolog: "SubsetElementInsert('Currency','sTmp','USD',1);",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const membership: DatasourceMembership = {
      byElement: new Map(),
      computedByProcess: new Map(),
      fetchErrors: [{ process: "P", object: "view C/vX", message: "boom" }],
    };
    const flow = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Currency", name: "USD" },
      datasourceMembership: membership,
    });
    expect(flow.element!.resolution).toContain(
      "(1 datasource object(s) could not be fetched — results may be incomplete)",
    );
  });

  it("scopes computedInProcesses to the traced dimension — cross-dimension computed selectors are excluded", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "P", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    // P's view has a computed selector on [Time] only — nothing computed on [Region].
    const membership: DatasourceMembership = {
      byElement: new Map(),
      computedByProcess: new Map([["P", new Map([["time", new Set(["TM1FILTERBYLEVEL"])]])]]),
      fetchErrors: [],
    };
    const flowRegion = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Region", name: "EMEA" },
      datasourceMembership: membership,
    });
    expect(flowRegion.element!.computedInProcesses).toBeUndefined();

    const flowTime = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Time", name: "2026" },
      datasourceMembership: membership,
    });
    expect(flowTime.element!.computedInProcesses).toEqual(["P"]);
  });

  it("includes unscoped ('*') computed selectors (whole-MDX-view) regardless of traced dimension", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "P", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    const membership: DatasourceMembership = {
      byElement: new Map(),
      computedByProcess: new Map([["P", new Map([["*", new Set(["TM1FILTERBYLEVEL"])]])]]),
      fetchErrors: [],
    };
    const flow = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Region", name: "EMEA" },
      datasourceMembership: membership,
    });
    expect(flow.element!.computedInProcesses).toEqual(["P"]);
  });

  it("merges in-code and stored-datasource access for the SAME process into one union, via populated, no dropped role", async () => {
    // In-code: SubsetElementInsert + ViewSubsetAssign + ViewZeroOut → contributes "zero-out".
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        {
          name: "P",
          prolog:
            "SubsetElementInsert('Currency','sTmp','USD',1);\nViewSubsetAssign('Sales','vTmp','Currency','sTmp');\nViewZeroOut('Sales','vTmp');",
          metadata: "",
          data: "",
          epilog: "",
          parameters: [],
        },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    // Bucket B: a stored-datasource membership hit for the SAME process + element → contributes "source".
    const membership: DatasourceMembership = {
      byElement: new Map([[elementKey("Currency", "USD"), [{ process: "P", via: "subset-static" }]]]),
      computedByProcess: new Map(),
      fetchErrors: [],
    };
    const flow = traceDataFlow(index, [], "Sales", "both", {
      element: { dimension: "Currency", name: "USD" },
      elementAccess: ["source", "write", "zero-out"],
      datasourceMembership: membership,
    });
    expect(flow.element!.processes).toEqual([
      { process: "P", funcNames: ["SubsetElementInsert"], access: ["source", "zero-out"], via: ["subset-static"] },
    ]);
  });
});
