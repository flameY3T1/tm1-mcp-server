import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collapseNameKeyedMaps } from "../helpers/wire-contract.js";
import type { Shape } from "../helpers/wire-contract.js";

/**
 * Contracts record structure and are committed to a public repository, so they
 * must not carry names out of the model they were recorded against. Stripping
 * object names from request paths covers names that appear as *values*; a
 * payload can also carry them as *keys*, which is how 120 dimension names of a
 * real model once reached this fixture via `dimensions.list.elementCounts`.
 *
 * The recorder collapses such maps to a single `*` entry. This is the gate that
 * says so: a committed contract must already be a fixed point of that collapse.
 */
const FIXTURES = ["wire-contracts.json", "service-contracts.json"] as const;

function load(name: string): Record<string, Shape> {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    endpoints?: Record<string, Shape>;
    methods?: Record<string, Shape>;
  };
  return parsed.endpoints ?? parsed.methods ?? {};
}

describe("committed contracts carry no model object names", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture}: every name-keyed map is already collapsed`, () => {
      const entries = load(fixture);
      const uncollapsed = Object.entries(entries).filter(
        ([, shape]) =>
          JSON.stringify(collapseNameKeyedMaps(shape)) !==
          JSON.stringify(shape),
      );
      expect(
        uncollapsed.map(([k]) => k),
        "re-run the contract recorder: these entries still spell out the keys " +
          "of a name-keyed map, which leaks names from the recorded model",
      ).toEqual([]);
    });
  }
});

describe("collapseNameKeyedMaps", () => {
  it("replaces a wide same-typed map with a single wildcard", () => {
    const dims = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`Dim_Confidential_${i}`, "number"]),
    );
    expect(collapseNameKeyedMaps(dims)).toEqual({ "*": "number" });
  });

  it("leaves a narrow record alone — few keys are a schema, not a map", () => {
    const rec: Shape = { name: "string", caption: "string" };
    expect(collapseNameKeyedMaps(rec)).toEqual(rec);
  });

  it("leaves a wide record with mixed types alone", () => {
    const rec = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `field${i}`,
        i % 2 === 0 ? "string" : "number",
      ]),
    );
    expect(collapseNameKeyedMaps(rec)).toEqual(rec);
  });

  it("does not mistake a wide list of arrays for a map", () => {
    const rec = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}[]`, "string"]),
    );
    expect(collapseNameKeyedMaps(rec)).toEqual(rec);
  });

  it("collapses maps nested inside a shape", () => {
    const shape: Shape = {
      "[]?": {
        name: "string",
        counts: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`Secret_${i}`, "number"]),
        ),
      },
    };
    expect(collapseNameKeyedMaps(shape)).toEqual({
      "[]?": { counts: { "*": "number" }, name: "string" },
    });
  });
});
