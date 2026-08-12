// The contract checker is load-bearing for ~40 other test files: if it says
// "conforms" too easily, every fake it guards goes unchecked. These cases pin
// the parts that decide that — array merging, optionality, union types, and
// the subset/exact split.
import { describe, it, expect } from "vitest";
import {
  shapeOf,
  mergeShapes,
  endpointKey,
  diffAgainstShape,
  type Shape,
} from "../helpers/wire-contract.js";

describe("shapeOf", () => {
  it("records primitive types, not values", () => {
    expect(shapeOf({ Name: "Sales", Cells: 42, Ok: true })).toEqual({
      Cells: "number",
      Name: "string",
      Ok: "boolean",
    });
  });

  it("marks an array key with [] and merges its elements", () => {
    expect(shapeOf({ value: [{ Name: "a" }, { Name: "b" }] })).toEqual({
      "value[]": { Name: "string" },
    });
  });

  it("makes a key optional when some element lacks it", () => {
    // This is the whole reason arrays are merged rather than sampled: TM1
    // omits keys per row (Attributes present on one element, absent on the
    // next), and a contract built from element 0 alone would call the second
    // element a violation.
    expect(
      shapeOf({ value: [{ Name: "a" }, { Name: "b", Alias: "x" }] }),
    ).toEqual({ "value[]": { "Alias?": "string", Name: "string" } });
  });

  it("unions differing primitive types", () => {
    expect(shapeOf([{ V: 1 }, { V: null }])).toEqual({
      "[]": { V: "null|number" },
    });
  });

  it("keeps a root-level array recognisable as an array", () => {
    // Inside an object the `[]` rides on the key; at the root there is no key,
    // so a service returning `CubeRules[]` would otherwise be indistinguishable
    // from one returning a single CubeRules.
    expect(shapeOf([{ Name: "a" }])).toEqual({ "[]": { Name: "string" } });
  });

  it("omits keys whose value is undefined", () => {
    expect(shapeOf({ a: 1, b: undefined })).toEqual({ a: "number" });
  });

  it("represents an empty array as unknown rather than guessing", () => {
    expect(shapeOf({ items: [] })).toEqual({ "items[]": "unknown" });
  });

  it("sorts keys so re-recording produces a readable diff", () => {
    expect(Object.keys(shapeOf({ b: 1, a: 2, c: 3 }))).toEqual(["a", "b", "c"]);
  });
});

describe("mergeShapes", () => {
  it("drops `unknown` once a real observation exists", () => {
    expect(mergeShapes("unknown", "string")).toBe("string");
  });

  it("lets a real element shape supersede the empty-array marker", () => {
    // An empty `Parents: []` on one element and a populated one on the next is
    // the norm in TM1. Merging these into the union "object" would erase the
    // element shape and make every later check pass vacuously.
    expect(mergeShapes("unknown", { Name: "string" })).toEqual({
      Name: "string",
    });
    expect(mergeShapes({ Name: "string" }, "unknown")).toEqual({
      Name: "string",
    });
  });

  it("keeps a key optional once either side saw it optional", () => {
    const a: Shape = { "X?": "string", Y: "number" };
    const b: Shape = { X: "string", Y: "number" };
    expect(mergeShapes(a, b)).toEqual({ "X?": "string", Y: "number" });
  });

  it("surfaces a primitive/object clash as a union instead of picking one", () => {
    expect(mergeShapes("string", { a: "number" })).toBe("object|string");
  });
});

describe("endpointKey", () => {
  it("strips object names — normalization and name-scrubbing in one", () => {
    expect(endpointKey("get", "/api/v1/Cubes('Sales_2026')/Views?$top=5")).toBe(
      "GET /api/v1/Cubes('*')/Views",
    );
  });

  it("strips numeric keys", () => {
    expect(endpointKey("PATCH", "/api/v1/Cellsets('abc')/Cells(0)")).toBe(
      "PATCH /api/v1/Cellsets('*')/Cells(*)",
    );
  });
});

describe("diffAgainstShape", () => {
  const CONTRACT: Shape = {
    "@odata.count?": "number",
    "value[]": { Name: "string", "Dimensions[]": { Name: "string" } },
  };

  it("accepts a payload that omits keys (that is what $select does)", () => {
    expect(diffAgainstShape({ value: [{ Name: "a" }] }, CONTRACT)).toEqual([]);
  });

  it("rejects a key the server never sends", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Invented: true }] },
      CONTRACT,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Invented");
    expect(problems[0]).toContain("does not send this key");
  });

  it("rejects a wrong primitive type", () => {
    const problems = diffAgainstShape({ value: [{ Name: 7 }] }, CONTRACT);
    expect(problems[0]).toContain("contract says string, payload has number");
  });

  it("rejects a scalar where the contract has an array", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Dimensions: "Time" }] },
      CONTRACT,
    );
    expect(problems[0]).toContain("contract says array");
  });

  it("reports the path of a nested divergence", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: "a", Dimensions: [{ Name: 1 }] }] },
      CONTRACT,
    );
    expect(problems[0]).toContain("$.value[0].Dimensions[0].Name");
  });

  it("lists every divergence at once", () => {
    const problems = diffAgainstShape(
      { value: [{ Name: 1, Bogus: 2 }] },
      CONTRACT,
    );
    expect(problems).toHaveLength(2);
  });

  it("exact mode additionally demands the required keys", () => {
    expect(diffAgainstShape({}, CONTRACT, { mode: "exact" })).toEqual([
      "$.value: required by the contract, missing from the payload",
    ]);
    // The optional one is not demanded.
    expect(
      diffAgainstShape({ value: [] }, CONTRACT, { mode: "exact" }),
    ).toEqual([]);
  });

  it("allows OData control annotations the contract never recorded", () => {
    // `@odata.count` appears only when the request asked for $count, and
    // contracts are filed with the query stripped — so its absence from a
    // recording says nothing about the payload being wrong.
    expect(
      diffAgainstShape(
        { value: [{ Name: "a" }], "Elements@odata.count": 3 },
        CONTRACT,
      ),
    ).toEqual([]);
  });

  it("checks an array of primitives element-wise", () => {
    // `Statements[]: "string"` means "array whose elements are strings", not
    // "a string". Comparing the array itself against the primitive would call
    // every string array a type error.
    expect(
      diffAgainstShape(
        { Statements: ["a", "b"] },
        { "Statements[]": "string" },
      ),
    ).toEqual([]);
    expect(
      diffAgainstShape({ Statements: [1] }, { "Statements[]": "string" }),
    ).toHaveLength(1);
  });

  it("treats an explicit undefined as an absent key", () => {
    // JSON cannot express `undefined`; a fake that spreads optional fields
    // produces it routinely and is making no claim by doing so.
    expect(
      diffAgainstShape({ value: [{ Name: "a", Nope: undefined }] }, CONTRACT),
    ).toEqual([]);
  });

  it("treats `unknown` as satisfied by anything", () => {
    expect(
      diffAgainstShape({ items: [1, 2] }, { "items[]": "unknown" }),
    ).toEqual([]);
  });

  it("accepts null where the contract recorded a nullable", () => {
    expect(diffAgainstShape({ V: null }, { V: "null|number" })).toEqual([]);
    expect(diffAgainstShape({ V: null }, { V: "number" })).toHaveLength(1);
  });
});
