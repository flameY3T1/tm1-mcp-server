import { describe, it, expect } from "vitest";
import { detectMissingConditionalFeeder } from "../../src/lib/feeders/static-heuristics.js";
import { parseBracketList } from "../../src/lib/feeders/brackets.js";

function lhs(text: string) {
  const r = parseBracketList(text);
  if (!r) throw new Error(`parse failed: ${text}`);
  return r;
}

describe("detectMissingConditionalFeeder — S3", () => {
  it("flags feeder that overlaps a conditional rule and lacks IF guard", () => {
    const condRules = [lhs("['A','B','C']")];
    expect(
      detectMissingConditionalFeeder(lhs("['A','D']"), false, condRules),
    ).toBe(true);
  });

  it("does not flag feeder that has its own IF guard", () => {
    const condRules = [lhs("['A','B','C']")];
    expect(
      detectMissingConditionalFeeder(lhs("['A','D']"), true, condRules),
    ).toBe(false);
  });

  it("does not flag feeder that does not overlap any conditional rule", () => {
    const condRules = [lhs("['X','Y','Z']")];
    expect(
      detectMissingConditionalFeeder(lhs("['A','B']"), false, condRules),
    ).toBe(false);
  });

  it("returns false when cube has no conditional rules", () => {
    expect(
      detectMissingConditionalFeeder(lhs("['A','B']"), false, []),
    ).toBe(false);
  });

  it("returns false on empty feeder bracket (S4 territory)", () => {
    expect(
      detectMissingConditionalFeeder(lhs("[]"), false, [lhs("['A']")]),
    ).toBe(false);
  });

  it("matches via qualified element ('Dim':'Elem') too", () => {
    const condRules = [lhs("['Year':'2026','Sales']")];
    expect(
      detectMissingConditionalFeeder(lhs("['Year':'2026']"), false, condRules),
    ).toBe(true);
  });
});
