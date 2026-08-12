// The naming audit asks TM1 for the elements that might violate a rule
// instead of downloading every element name. That only works if the filter is
// SOUND: it may return names that turn out fine, but it must never omit a name
// `checkName` would flag. These tests pin exactly that property — the filter is
// a prefilter, `checkName` stays the authority.
import { describe, it, expect } from "vitest";
import { checkName } from "../../src/lib/naming/rules.js";
import {
  elementViolationFilter,
  matchesElementViolationFilter,
} from "../../src/lib/naming/odata-filter.js";

// Names that violate at least one element rule, one per rule class plus the
// awkward cases (quote doubling, unicode whitespace, tab).
const VIOLATING = [
  "",
  "   ",
  " leading",
  "trailing ",
  "\ttabbed",
  "}Control",
  "+plus",
  "-minus",
  "back\\slash",
  "fwd/slash",
  "colon:here",
  "star*here",
  "quest?here",
  'quote"here',
  "lt<here",
  "gt>here",
  "pipe|here",
  "apo'strophe",
  "semi;colon",
  "comma,here",
  "mid\tdle",
];

const CLEAN = [
  "Sales",
  "Total_Revenue",
  "2026",
  "Kosten (netto)",
  "a-b", // hyphen only leads a violation at position 0
  "München",
  "x".repeat(300), // elements have no length cap
];

describe("elementViolationFilter", () => {
  it("is sound: every name checkName flags is matched", () => {
    for (const name of VIOLATING) {
      const flagged = checkName(name, "element", 12).length > 0;
      expect(flagged, `${JSON.stringify(name)} should violate a rule`).toBe(
        true,
      );
      expect(
        matchesElementViolationFilter(name, 12),
        `filter must not miss ${JSON.stringify(name)}`,
      ).toBe(true);
    }
  });

  it("does not flag clean names, so the fetched candidate set stays small", () => {
    // Not a correctness requirement — an over-wide filter would still produce
    // the right answer, just a bigger download. Worth pinning anyway.
    for (const name of CLEAN) {
      expect(
        matchesElementViolationFilter(name, 12),
        `${JSON.stringify(name)} should not be a candidate`,
      ).toBe(false);
    }
  });

  it("only looks for TAB on v12, where it is reserved", () => {
    expect(matchesElementViolationFilter("mid\tdle", 12)).toBe(true);
    expect(matchesElementViolationFilter("mid\tdle", 11)).toBe(false);
    // …matching checkName, which gates the same rule on the version.
    expect(checkName("mid\tdle", "element", 11)).toEqual([]);
  });

  it("doubles a single quote, the one literal OData can misparse", () => {
    const f = elementViolationFilter(11);
    expect(f).toContain("contains(Name,'''')");
  });

  it("expresses whitespace with trim() rather than a space list", () => {
    // `name !== name.trim()` covers every unicode space JS trims. Enumerating
    // them as startswith/endswith clauses would silently miss the ones nobody
    // thought of, which is the failure mode this filter must not have.
    const f = elementViolationFilter(11);
    expect(f).toContain("trim(Name) ne Name");
    expect(f).toContain("length(trim(Name)) eq 0");
  });

  it("emits TAB as an escaped literal, never a raw control character", () => {
    const f = elementViolationFilter(12);
    expect(f).not.toContain("\t");
    expect(f).toContain("indexof(Name,'%09')");
  });
});
