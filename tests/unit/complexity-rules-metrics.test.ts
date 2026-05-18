import { describe, it, expect } from "vitest";
import { computeRulesMetrics } from "../../src/lib/complexity/rules-metrics.js";

describe("computeRulesMetrics", () => {
  it("returns zero metrics for empty rules text", () => {
    const m = computeRulesMetrics("Empty", "");
    expect(m.rulesLoc).toBe(0);
    expect(m.ruleCount).toBe(0);
    expect(m.score).toBe(0);
  });

  it("counts rule areas, feeders, comments, blanks", () => {
    const src = [
      "# header comment",
      "skipcheck;",
      "['Sales','Q1'] = N: 100;",
      "['Sales','Q2'] = N: 200;",
      "",
      "feeders;",
      "['Sales','Q1'] => ['Sales','Q2'];",
    ].join("\n");
    const m = computeRulesMetrics("Sales", src);
    expect(m.hasSkipcheck).toBe(true);
    expect(m.ruleCount).toBe(2);
    expect(m.feederCount).toBe(1);
    expect(m.commentLines).toBe(1);
    expect(m.rulesLoc).toBe(3);
    expect(m.feedersLoc).toBe(2);
  });

  it("detects feedstrings directive", () => {
    const src = [
      "skipcheck;",
      "feedstrings;",
      "['X'] = S: 'hi';",
      "feeders;",
    ].join("\n");
    const m = computeRulesMetrics("X", src);
    expect(m.hasFeedstrings).toBe(true);
    expect(m.hasSkipcheck).toBe(true);
  });

  it("computes commentRatio = comments / (rulesLoc + feedersLoc + comments)", () => {
    const src = ["# c1", "# c2", "['A'] = N: 1;"].join("\n");
    const m = computeRulesMetrics("A", src);
    expect(m.commentLines).toBe(2);
    expect(m.rulesLoc).toBe(1);
    expect(m.commentRatio).toBeCloseTo(2 / 3, 4);
  });

  it("counts DB() calls and unique coupled cubes", () => {
    const src = [
      "['Tgt','Q1'] = N: DB('Src1','x','y') + DB('Src2','a','b');",
      "['Tgt','Q2'] = N: DB('Src1','x','z');",
    ].join("\n");
    const m = computeRulesMetrics("Tgt", src);
    expect(m.dbCallCount).toBe(3);
    expect(m.coupledCubes).toEqual(["Src1", "Src2"]);
  });

  it("ignores DB() inside comments and string literals", () => {
    const src = [
      "# DB('FakeCube','x','y')",
      "['A'] = S: 'DB(\"Other\",1,2)';",
    ].join("\n");
    const m = computeRulesMetrics("A", src);
    expect(m.dbCallCount).toBe(0);
    expect(m.coupledCubes).toEqual([]);
  });

  it("score reflects DB-coupling more than plain rules", () => {
    const simple = computeRulesMetrics("Simple", "['A'] = N: 1;");
    const coupled = computeRulesMetrics(
      "Coupled",
      "['A'] = N: DB('Other','x','y');",
    );
    expect(coupled.score).toBeGreaterThan(simple.score);
  });
});
