import { describe, expect, it } from "vitest";
import { isCommentedOutCode } from "../../src/lib/complexity/comment-classifier.js";
import { computeRulesMetrics } from "../../src/lib/complexity/rules-metrics.js";
import { computeProcessMetrics } from "../../src/lib/complexity/process-metrics.js";

describe("isCommentedOutCode", () => {
  it("flags disabled statements ending in a semicolon", () => {
    expect(isCommentedOutCode("# ['Sales'] = 100;")).toBe(true);
    expect(isCommentedOutCode("#vResult = CellGetN('Cube', !d1);")).toBe(true);
    expect(isCommentedOutCode("# nTotal = nA + nB;")).toBe(true);
  });

  it("flags rule-area assignments and known function calls", () => {
    expect(isCommentedOutCode("#['Revenue','Actual'] = DB('Sales', !x)")).toBe(true);
    expect(isCommentedOutCode("# CellPutN(0, 'Cube', !e1, !e2)")).toBe(true);
    expect(isCommentedOutCode("## IF(vX > 0)")).toBe(true);
  });

  it("flags bare TM1 directives", () => {
    expect(isCommentedOutCode("# SKIPCHECK;")).toBe(true);
    expect(isCommentedOutCode("#FEEDERS")).toBe(true);
    expect(isCommentedOutCode("# ENDIF")).toBe(true);
  });

  it("treats natural-language prose as a real comment", () => {
    expect(isCommentedOutCode("# This rule allocates revenue by headcount")).toBe(false);
    expect(isCommentedOutCode("# TODO: revisit after Q3 close")).toBe(false);
    expect(isCommentedOutCode("# Author: finance team, see ticket 1234")).toBe(false);
    expect(isCommentedOutCode("#")).toBe(false);
    expect(isCommentedOutCode("# ----------------------------------")).toBe(false);
  });
});

describe("rules-metrics dead-code split", () => {
  const rules = [
    "# Allocation rules for the Sales cube", // real comment
    "['Margin'] = ['Revenue'] - ['Cost'];", // active code
    "# ['Revenue'] = DB('Old', !x);", // commented-out code
    "# nLegacy = 5;", // commented-out code
    "feeders;",
    "['Revenue'] => ['Margin'];",
  ].join("\n");

  it("counts commented-out code separately from real comments", () => {
    const m = computeRulesMetrics("Sales", rules);
    expect(m.commentLines).toBe(1);
    expect(m.deadCodeLines).toBe(2);
    expect(m.deadCodeRatio).toBeGreaterThan(0);
    // Ratios share one denominator (all non-blank, non-marker lines).
    expect(m.commentRatio + m.deadCodeRatio).toBeLessThanOrEqual(1);
  });
});

describe("process-metrics dead-code split", () => {
  it("separates disabled TI statements from prose comments", () => {
    const code = {
      prolog: [
        "# Load source data into the staging cube", // real comment
        "nCount = 0;", // active
        "# vOld = CellGetN('Stage', !period);", // dead code
        "# CellPutN(nCount, 'Stage', !period);", // dead code
        "nCount = nCount + 1;", // active
      ].join("\n"),
      metadata: "",
      data: "",
      epilog: "",
    };
    const m = computeProcessMetrics("Stage.Load", code);
    expect(m.totals.commentLines).toBe(1);
    expect(m.totals.deadCodeLines).toBe(2);
    expect(m.totals.deadCodeRatio).toBeGreaterThan(0);
  });

  it("commentRatio no longer inflated by commented-out code", () => {
    const heavyDeadCode = {
      prolog: [
        "nActive = 1;",
        "# vA = CellGetN('C', !x);",
        "# vB = CellGetN('C', !y);",
        "# CellPutN(vA + vB, 'C', !z);",
      ].join("\n"),
      metadata: "",
      data: "",
      epilog: "",
    };
    const m = computeProcessMetrics("DeadHeavy", heavyDeadCode);
    // 1 loc + 0 real comments + 3 dead → commentRatio must be 0, not 0.75.
    expect(m.totals.commentLines).toBe(0);
    expect(m.totals.commentRatio).toBe(0);
    expect(m.totals.deadCodeLines).toBe(3);
  });
});
