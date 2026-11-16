import { describe, it, expect } from "vitest";
import {
  extractStringLiteral,
  extractTiReferences,
} from "../../src/lib/callgraph/referenceIndex.js";
import { buildProcessEnv } from "../../src/lib/callgraph/variableEnv.js";

describe("'' inside a TI string literal is one quote", () => {
  it("extractStringLiteral unescapes it", () => {
    expect(extractStringLiteral("'it''s'")).toBe("it's");
    expect(extractStringLiteral("''''")).toBe("'");
    expect(extractStringLiteral("'plain'")).toBe("plain");
  });

  it("extractStringLiteral still refuses what is not one literal", () => {
    expect(extractStringLiteral("''")).toBeNull();
    expect(extractStringLiteral("'a' | 'b'")).toBeNull();
    expect(extractStringLiteral("'it's'")).toBeNull();
    expect(extractStringLiteral("sVar")).toBeNull();
  });

  it("a process called with such a name is found", () => {
    const refs = extractTiReferences("ExecuteProcess('it''s');");
    expect(refs.map((r) => `${r.targetKind}=${r.targetName}`)).toEqual([
      "process=it's",
    ]);
  });

  it("a variable holding such a name resolves to a literal", () => {
    const env = buildProcessEnv("sX = 'it''s';", []);
    expect(env.vars.get("sx")).toEqual({ kind: "literal", value: "it's" });
  });
});
