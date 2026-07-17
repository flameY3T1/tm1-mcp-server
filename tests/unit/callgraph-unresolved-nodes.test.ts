import { describe, it, expect } from "vitest";
import { buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";
import { buildCallGraph } from "../../src/lib/callgraph/callGraph.js";

async function indexWithDynamicCall() {
  return buildReferenceIndex({
    fetchProcesses: async () => [
      { name: "Orchestrator", prolog: "ExecuteProcess('Child');\nsDyn = 'a' | 'b';\nExecuteProcess(sDyn);", metadata: "", data: "", epilog: "", parameters: [] },
      { name: "Child", prolog: "", metadata: "", data: "", epilog: "", parameters: [] },
    ],
    fetchCubesWithRules: async () => [],
    fetchChores: async () => [],
  });
}

describe("buildCallGraph — unresolvedCalls on nodes", () => {
  it("attaches unresolvedCalls to downstream root node", async () => {
    const index = await indexWithDynamicCall();
    const tree = buildCallGraph(index, "Orchestrator", { direction: "downstream" });
    expect(tree.unresolvedCalls).toBeDefined();
    expect(tree.unresolvedCalls?.length).toBe(1);
    expect(tree.unresolvedCalls?.[0]?.reason).toBe("dynamic");
  });

  it("omits unresolvedCalls for upstream direction", async () => {
    const index = await indexWithDynamicCall();
    const tree = buildCallGraph(index, "Orchestrator", { direction: "upstream" });
    expect(tree.unresolvedCalls).toBeUndefined();
  });
});
