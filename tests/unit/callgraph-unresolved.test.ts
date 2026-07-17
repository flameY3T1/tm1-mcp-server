import { describe, it, expect } from "vitest";
import { extractTiReferences, buildReferenceIndex } from "../../src/lib/callgraph/referenceIndex.js";

// extractTiReferences(text, env?, sharedLiveVars?, unresolvedOut?) — 4th out-param collects
// process-call call-sites whose target could not be resolved to a literal.

describe("extractTiReferences unresolved process calls", () => {
  it("records dynamic (concatenated) ExecuteProcess target", () => {
    const unresolved: unknown[] = [];
    const refs = extractTiReferences(
      "sDyn = 'te' | 'st';\nExecuteProcess(sDyn);",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(refs).toEqual([]);
    expect(unresolved).toEqual([
      {
        line: 1,
        funcName: "ExecuteProcess",
        expr: "sDyn",
        snippet: "ExecuteProcess(sDyn);",
        reason: "dynamic",
      },
    ]);
  });

  it("records param-target RunProcess call as reason: 'param'", () => {
    const unresolved: unknown[] = [];
    const refs = extractTiReferences(
      "RunProcess(pProcessName);",
      {
        paramsLc: new Set(["pprocessname"]),
        paramOriginal: new Map([["pprocessname", "pProcessName"]]),
        paramTypes: new Map(),
        datasourceVars: new Map(),
        vars: new Map(),
      },
      undefined,
      unresolved as never,
    );
    expect(refs).toEqual([]);
    expect(unresolved).toEqual([
      {
        line: 0,
        funcName: "RunProcess",
        expr: "pProcessName",
        snippet: "RunProcess(pProcessName);",
        reason: "param",
      },
    ]);
  });

  it("does not populate unresolvedOut when target resolves to a literal", () => {
    const unresolved: unknown[] = [];
    const refs = extractTiReferences(
      "ExecuteProcess('Sub');",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(refs.filter(r => r.targetName === "Sub")).toHaveLength(1);
    expect(unresolved).toEqual([]);
  });

  it("does NOT record dynamic CUBE targets (scope guard — process calls only)", () => {
    const unresolved: unknown[] = [];
    extractTiReferences(
      "sDyn = 'a' | 'b';\nnV = CellGetN(sDyn, 'x');",
      undefined,
      undefined,
      unresolved as never,
    );
    expect(unresolved).toEqual([]);
  });
});

describe("buildReferenceIndex — unresolvedCallsBySourceProcess", () => {
  it("buckets unresolved calls per source process section", async () => {
    const index = await buildReferenceIndex({
      fetchProcesses: async () => [
        { name: "P", prolog: "sDyn = 'a' | 'b';\nExecuteProcess(sDyn);", metadata: "", data: "", epilog: "", parameters: [] },
      ],
      fetchCubesWithRules: async () => [],
      fetchChores: async () => [],
    });
    expect(index.unresolvedCallsBySourceProcess.get("p")).toEqual([
      { section: "prolog", line: 1, funcName: "ExecuteProcess", expr: "sDyn", snippet: "ExecuteProcess(sDyn);", reason: "dynamic" },
    ]);
  });
});
