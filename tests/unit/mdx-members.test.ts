import { describe, it, expect } from "vitest";
import { extractMdxMemberRefs, membersFromAxis } from "../../src/lib/callgraph/mdxMembers.js";

describe("extractMdxMemberRefs", () => {
  it("extracts a two-part [Dim].[Element] member", () => {
    const r = extractMdxMemberRefs("{ [Datenquellen].[SuDatenquellen_C] }");
    expect(r.members).toEqual([{ dimension: "Datenquellen", element: "SuDatenquellen_C" }]);
    expect(r.computedSelectors).toEqual([]);
  });

  it("takes dimension from first part and element from last part of a 3-part ref", () => {
    const r = extractMdxMemberRefs("[Kunde].[Kunde].[K100]");
    expect(r.members).toEqual([{ dimension: "Kunde", element: "K100" }]);
  });

  it("flags computed selectors and does NOT invent members for them", () => {
    const r = extractMdxMemberRefs("{TM1FILTERBYLEVEL(TM1SUBSETALL([Datenquellen]),0)}");
    expect(r.members).toEqual([]); // [Datenquellen] alone is a dimension ref, not a member
    expect(r.computedSelectors.sort()).toEqual(["TM1FILTERBYLEVEL", "TM1SUBSETALL"]);
  });

  it("captures explicit members even alongside a computed selector", () => {
    const r = extractMdxMemberRefs("{ DESCENDANTS([Zeit].[2026]) , [Datenquellen].[SuDatenquellen_C] }");
    expect(r.members).toEqual([
      { dimension: "Zeit", element: "2026" },
      { dimension: "Datenquellen", element: "SuDatenquellen_C" },
    ]);
    expect(r.computedSelectors).toEqual(["DESCENDANTS"]);
  });

  it("dedupes repeated members", () => {
    const r = extractMdxMemberRefs("[D].[E] + [D].[E]");
    expect(r.members).toEqual([{ dimension: "D", element: "E" }]);
  });

  it("dedupes members case-insensitively, keeping the first-seen casing", () => {
    const r = extractMdxMemberRefs("[Kunde].[K100] + [KUNDE].[k100]");
    expect(r.members).toEqual([{ dimension: "Kunde", element: "K100" }]);
  });
});

describe("membersFromAxis", () => {
  it("returns only the matching-dimension names from a mixed-hierarchy axis 0", () => {
    const res = {
      axes: [
        {
          tuples: [
            { members: [{ name: "EMEA", hierarchyName: "Region" }, { name: "2026", hierarchyName: "Time" }] },
            { members: [{ name: "APAC", hierarchyName: "Region" }, { name: "2027", hierarchyName: "Time" }] },
          ],
        },
      ],
    };
    expect(membersFromAxis(res, "Region")).toEqual(["EMEA", "APAC"]);
  });

  it("matches the dimension case-insensitively", () => {
    const res = { axes: [{ tuples: [{ members: [{ name: "EMEA", hierarchyName: "REGION" }] }] }] };
    expect(membersFromAxis(res, "region")).toEqual(["EMEA"]);
  });

  it("returns [] when axis 0 is absent", () => {
    expect(membersFromAxis({ axes: [] }, "Region")).toEqual([]);
    expect(membersFromAxis({}, "Region")).toEqual([]);
  });

  it("returns [] for empty tuples", () => {
    expect(membersFromAxis({ axes: [{ tuples: [] }] }, "Region")).toEqual([]);
  });
});
