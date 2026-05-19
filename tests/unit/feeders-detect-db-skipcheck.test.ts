import { describe, it, expect } from "vitest";
import { detectDbFeederWithoutSkipcheck } from "../../src/lib/feeders/static-heuristics.js";

describe("detectDbFeederWithoutSkipcheck — S5", () => {
  it("returns null when line has no DB() call", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => ['Other','X','Y'];",
      () => true,
    );
    expect(result).toBeNull();
  });

  it("flags DB() to a cube without skipcheck", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('OtherCube','X','Y');",
      (name) => (name === "OtherCube" ? false : null),
    );
    expect(result).toBe("OtherCube");
  });

  it("returns null when DB() target has skipcheck", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('OtherCube','X','Y');",
      (name) => (name === "OtherCube" ? true : null),
    );
    expect(result).toBeNull();
  });

  it("returns null when DB() target unknown (not in scan scope)", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB('UnknownCube','X','Y');",
      () => null,
    );
    expect(result).toBeNull();
  });

  it("skips DB() with dynamic (non-string-literal) cube name", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => DB(sCube,'X','Y');",
      () => false,
    );
    expect(result).toBeNull();
  });

  it("returns first offending target across multiple DB() calls", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A'] => DB('CubeOK','X') * DB('CubeBad','Y');",
      (name) => {
        if (name === "CubeOK") return true;
        if (name === "CubeBad") return false;
        return null;
      },
    );
    expect(result).toBe("CubeBad");
  });

  it("ignores DB() inside string literals (extractor handles this)", () => {
    const result = detectDbFeederWithoutSkipcheck(
      "['A','B'] => 'not a DB call' ;",
      () => false,
    );
    expect(result).toBeNull();
  });
});
