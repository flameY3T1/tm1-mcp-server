import { describe, it, expect } from "vitest";
import { extractRulesReferences } from "../../src/lib/callgraph/referenceIndex.js";

const dims = (text: string) =>
  extractRulesReferences(text)
    .filter((r) => r.targetKind === "dimension")
    .map((r) => r.targetName);

describe("extractRulesReferences: dimensions named in [...]", () => {
  it("reads a fully qualified reference", () => {
    expect(dims("['Year':'2026','Measure':'Sales'] = N: 1;")).toEqual([
      "Year",
      "Measure",
    ]);
  });

  it("reads the qualified entries of a mixed reference", () => {
    // Legal in TM1 and common in real rules; this used to yield nothing.
    expect(dims("['Year':'2026','Sales'] = N: 1;")).toEqual(["Year"]);
  });

  it("reads a set entry", () => {
    expect(dims("['Year':{'2026','2027'},'Sales'] = N: 1;")).toEqual(["Year"]);
  });

  it("unescapes '' in a dimension name", () => {
    expect(dims("['It''s':'A''B'] = N: 1;")).toEqual(["It's"]);
  });

  it("yields no dimension for a positional reference", () => {
    expect(dims("['2026','Sales'] = N: 1;")).toEqual([]);
  });

  it("ignores brackets in a comment and inside a string", () => {
    expect(dims("['Year':'2026'] = N: 1; # ['Ghost':'x']")).toEqual(["Year"]);
    expect(dims("['Year':'2026'] = S: '[''Ghost'':''x'']';")).toEqual(["Year"]);
  });

  it("tags the feeders section", () => {
    const refs = extractRulesReferences(
      "['Year':'2026'] = N: 1;\nFEEDERS;\n['Region':'North','Sales'] => ['Plan'];",
    );
    expect(refs.map((r) => `${r.section}:${r.targetName}`)).toEqual([
      "rules:Year",
      "feeders:Region",
    ]);
  });
});
