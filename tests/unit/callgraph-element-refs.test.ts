import { describe, it, expect } from "vitest";
import { buildReferenceIndex, elementKey, extractTiReferences } from "../../src/lib/callgraph/referenceIndex.js";

// Shared minimal deps (mirror tests/unit/callgraph-global-ranking.test.ts shape:
// only process code varies; cubes/chores empty).
function indexOf(prolog: string) {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      { name: "P", prolog, metadata: "", data: "", epilog: "", parameters: [] },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

describe("byElement reverse index", () => {
  it("indexes a literal SubsetElementInsert element under (dim, element)", async () => {
    const index = await indexOf(
      "SubsetCreate('sTmp','Datenquellen',1);\nSubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);",
    );
    const refs = index.byElement.get(elementKey("Datenquellen", "SuDatenquellen_C"));
    expect(refs).toBeDefined();
    expect(refs!.map((r) => ({ kind: r.targetKind, dim: r.dimension, name: r.targetName, src: r.sourceName }))).toEqual([
      { kind: "element", dim: "Datenquellen", name: "SuDatenquellen_C", src: "P" },
    ]);
  });
});

describe("extractTiReferences — element refs from subset-membership calls", () => {
  it("emits an element ref (with dimension) for SubsetElementInsert", () => {
    const refs = extractTiReferences(
      "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el).toEqual([
      { line: 0, funcName: "SubsetElementInsert", targetKind: "element", targetName: "SuDatenquellen_C", dimension: "Datenquellen", snippet: "SubsetElementInsert('Datenquellen','sTmp','SuDatenquellen_C',1);", params: undefined },
    ]);
  });

  it("handles SubsetElementAdd arg order (dim at index 1)", () => {
    const refs = extractTiReferences("SubsetElementAdd('sTmp','Kunde','K100');");
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([{ dim: "Kunde", name: "K100" }]);
  });

  it("resolves a variable dimension via live-var tracking", () => {
    const refs = extractTiReferences(
      "csDim = 'Datenquellen';\nSubsetElementInsert(csDim,'sTmp','SuDatenquellen_C',1);",
    );
    const el = refs.filter((r) => r.targetKind === "element");
    expect(el.map((r) => ({ dim: r.dimension, name: r.targetName }))).toEqual([
      { dim: "Datenquellen", name: "SuDatenquellen_C" },
    ]);
  });

  it("surfaces a non-literal element arg as unresolved, not a resolved ref", () => {
    const unresolvedElem: unknown[] = [];
    const refs = extractTiReferences(
      "SubsetElementInsert('Datenquellen','sTmp',CellGetS('C','x'),1);",
      undefined,
      undefined,
      undefined,
      unresolvedElem as never,
    );
    expect(refs.filter((r) => r.targetKind === "element")).toEqual([]);
    expect(unresolvedElem).toEqual([
      { line: 0, funcName: "SubsetElementInsert", dimension: "Datenquellen", expr: "CellGetS('C','x')", snippet: "SubsetElementInsert('Datenquellen','sTmp',CellGetS('C','x'),1);", reason: "dynamic" },
    ]);
  });
});

describe("buildReferenceIndex — unresolvedElementRefsBySourceProcess", () => {
  it("buckets a dynamic element arg per source process", async () => {
    const index = await indexOf("SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);");
    expect(index.unresolvedElementRefsBySourceProcess.get("p")).toEqual([
      { section: "prolog", line: 0, funcName: "SubsetElementInsert", dimension: "Kunde", expr: "CellGetS('C','x')", snippet: "SubsetElementInsert('Kunde','sTmp',CellGetS('C','x'),1);", reason: "dynamic" },
    ]);
  });
});
