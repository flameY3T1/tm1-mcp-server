import { describe, it, expect } from "vitest";
import {
  detectWildcardBracket,
  detectBroaderThanRule,
  detectOrphanFeeder,
  collectElementBag,
} from "../../src/lib/feeders/static-heuristics.js";
import { parseBracketList } from "../../src/lib/feeders/brackets.js";

function lhs(text: string) {
  const r = parseBracketList(text);
  if (!r) throw new Error(`parse failed: ${text}`);
  return r;
}

describe("detectWildcardBracket — S4", () => {
  it("flags empty bracket as wildcard", () => {
    expect(detectWildcardBracket(lhs("[]"))).toBe(true);
  });

  it("does not flag bracket with concrete elements", () => {
    expect(detectWildcardBracket(lhs("['A','B']"))).toBe(false);
  });

  it("does not flag qualified bracket with elements", () => {
    expect(detectWildcardBracket(lhs("['Year':'2026']"))).toBe(false);
  });

  it("does not flag set-form bracket with elements", () => {
    expect(detectWildcardBracket(lhs("['Year':{'2025','2026'}]"))).toBe(false);
  });
});

describe("detectBroaderThanRule — S1", () => {
  it("flags feeder with strictly fewer constraints than the rule it covers", () => {
    const ruleLhs = [lhs("['A','B','C','D','E']")];
    const feeder = lhs("['A','B']");
    expect(detectBroaderThanRule(feeder, ruleLhs)).toBe(true);
  });

  it("does not flag feeder with same number of constraints as the rule", () => {
    const ruleLhs = [lhs("['A','B','C']")];
    const feeder = lhs("['A','B','C']");
    expect(detectBroaderThanRule(feeder, ruleLhs)).toBe(false);
  });

  it("does not flag feeder with MORE constraints than the rule", () => {
    const ruleLhs = [lhs("['A','B']")];
    const feeder = lhs("['A','B','C','D']");
    expect(detectBroaderThanRule(feeder, ruleLhs)).toBe(false);
  });

  it("uses the densest rule as comparison baseline", () => {
    const ruleLhs = [lhs("['A','B']"), lhs("['A','B','C','D','E']")];
    const feeder = lhs("['A','B']");
    expect(detectBroaderThanRule(feeder, ruleLhs)).toBe(true);
  });

  it("returns false when no rules exist (cube has feeders without rules)", () => {
    const feeder = lhs("['A','B']");
    expect(detectBroaderThanRule(feeder, [])).toBe(false);
  });
});

describe("detectOrphanFeeder — S6", () => {
  it("flags feeder whose elements share nothing with any rule LHS", () => {
    const ruleLhs = [lhs("['X','Y','Z']")];
    const feeder = lhs("['A','B','C']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(true);
  });

  it("does not flag feeder that shares at least one element with a rule", () => {
    const ruleLhs = [lhs("['X','Y','Z']")];
    const feeder = lhs("['Z','A']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });

  it("checks across all rules, not just the first", () => {
    const ruleLhs = [lhs("['X','Y']"), lhs("['M','N']")];
    const feeder = lhs("['N']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });

  it("returns false when feeder bracket has no entries (wildcard handled by S4)", () => {
    const ruleLhs = [lhs("['X','Y']")];
    expect(detectOrphanFeeder(lhs("[]"), ruleLhs)).toBe(false);
  });

  it("matches via qualified element ('Dim':'Elem') too", () => {
    const ruleLhs = [lhs("['Year':'2026','Sales']")];
    const feeder = lhs("['Year':'2026']");
    expect(detectOrphanFeeder(feeder, ruleLhs)).toBe(false);
  });
});

describe("collectElementBag — bag semantics", () => {
  it("collects positional elements", () => {
    expect([...collectElementBag(lhs("['A','B','C']"))]).toEqual(
      expect.arrayContaining(["A", "B", "C"]),
    );
  });

  it("collects qualified element values", () => {
    expect([...collectElementBag(lhs("['Year':'2026','Sales']"))]).toEqual(
      expect.arrayContaining(["2026", "Sales"]),
    );
  });

  it("expands set-form elements", () => {
    expect([...collectElementBag(lhs("['Year':{'2025','2026'}]"))]).toEqual(
      expect.arrayContaining(["2025", "2026"]),
    );
  });
});
