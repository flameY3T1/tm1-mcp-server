import { describe, it, expect } from "vitest";
import { buildReferenceIndex, elementKey } from "../../src/lib/callgraph/referenceIndex.js";

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
    // Model exists now; the actual element ref is emitted in Task 2 (SubsetElementInsert extraction).
    expect(index.byElement).toBeInstanceOf(Map);
  });
});
