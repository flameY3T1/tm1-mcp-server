import { describe, it, expect } from "vitest";
import {
  normalizeVarName,
  clusterVariableNames,
  findTypeInconsistencies,
  reportPrefixConvention,
  groupByCohort,
} from "../../src/lib/complexity/cross-process.js";

describe("normalizeVarName", () => {
  it("strips [pvns] prefix when followed by uppercase", () => {
    expect(normalizeVarName("pYear")).toBe("year");
    expect(normalizeVarName("vYear")).toBe("year");
    expect(normalizeVarName("nCount")).toBe("count");
    expect(normalizeVarName("sName")).toBe("name");
  });

  it("strips [pvns] prefix when followed by underscore", () => {
    expect(normalizeVarName("p_year")).toBe("year");
    expect(normalizeVarName("v_total_amount")).toBe("totalamount");
  });

  it("keeps unprefixed names as-is (lowercased)", () => {
    expect(normalizeVarName("Year")).toBe("year");
    expect(normalizeVarName("Total_Amount")).toBe("totalamount");
  });

  it("does not strip if next char is lowercase non-underscore", () => {
    expect(normalizeVarName("plant")).toBe("plant");
    expect(normalizeVarName("name")).toBe("name");
  });
});

describe("clusterVariableNames", () => {
  it("groups variants pointing to the same concept", () => {
    const clusters = clusterVariableNames([
      { process: "A", variables: [{ name: "pYear", type: "Numeric" }] },
      { process: "B", variables: [{ name: "vYear", type: "Numeric" }] },
      { process: "C", variables: [{ name: "Year", type: "Numeric" }] },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.normalized).toBe("year");
    expect(clusters[0]!.variants).toEqual(["Year", "pYear", "vYear"]);
    expect(clusters[0]!.processes).toEqual(["A", "B", "C"]);
  });

  it("does not flag a single canonical name", () => {
    const clusters = clusterVariableNames([
      { process: "A", variables: [{ name: "pYear", type: "Numeric" }] },
      { process: "B", variables: [{ name: "pYear", type: "Numeric" }] },
    ]);
    expect(clusters).toEqual([]);
  });

  it("ranks clusters by variant count descending", () => {
    const clusters = clusterVariableNames([
      { process: "A", variables: [
        { name: "pYear", type: "Numeric" },
        { name: "vYear", type: "Numeric" },
        { name: "Year", type: "Numeric" },
      ]},
      { process: "B", variables: [
        { name: "pCube", type: "String" },
        { name: "vCube", type: "String" },
      ]},
    ]);
    expect(clusters[0]!.normalized).toBe("year");
    expect(clusters[1]!.normalized).toBe("cube");
  });
});

describe("findTypeInconsistencies", () => {
  it("flags same name with different types across processes", () => {
    const out = findTypeInconsistencies([
      { process: "A", variables: [{ name: "pDate", type: "Numeric" }] },
      { process: "B", variables: [{ name: "pDate", type: "String" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.variable).toBe("pDate");
    expect(out[0]!.occurrences).toEqual([
      { type: "Numeric", processes: ["A"] },
      { type: "String", processes: ["B"] },
    ]);
  });

  it("ignores variables that are consistently typed", () => {
    const out = findTypeInconsistencies([
      { process: "A", variables: [{ name: "pDate", type: "String" }] },
      { process: "B", variables: [{ name: "pDate", type: "String" }] },
    ]);
    expect(out).toEqual([]);
  });
});

describe("reportPrefixConvention", () => {
  it("computes distribution and adherence", () => {
    const r = reportPrefixConvention([
      { process: "A", variables: [
        { name: "pYear", type: "Numeric" },
        { name: "pMonth", type: "Numeric" },
        { name: "vSum", type: "Numeric" },
        { name: "year", type: "Numeric" },
      ]},
    ]);
    expect(r.total).toBe(4);
    expect(r.unprefixed).toBe(1);
    expect(r.adherence).toBeCloseTo(3 / 4, 4);
    expect(r.distribution[0]).toEqual({ prefix: "p", count: 2 });
  });

  it("returns zero adherence for empty input", () => {
    const r = reportPrefixConvention([]);
    expect(r.total).toBe(0);
    expect(r.adherence).toBe(0);
    expect(r.distribution).toEqual([]);
  });
});

describe("groupByCohort", () => {
  it("groups by trailing alpha suffix", () => {
    const cohorts = groupByCohort([
      { process: "Load_Sales" },
      { process: "Aggregate_Sales" },
      { process: "Load_Forecast" },
      { process: "Aggregate_Forecast" },
      { process: "Standalone" },
    ]);
    const keys = cohorts.map((c) => c.key).sort();
    expect(keys).toEqual(["forecast", "sales"]);
    const sales = cohorts.find((c) => c.key === "sales")!;
    expect(sales.members).toEqual(["Aggregate_Sales", "Load_Sales"]);
  });

  it("omits singleton cohorts", () => {
    const cohorts = groupByCohort([
      { process: "Solo_Only" },
      { process: "OtherSolo" },
    ]);
    expect(cohorts).toEqual([]);
  });

  it("supports dash separator", () => {
    const cohorts = groupByCohort([
      { process: "load-sales" },
      { process: "agg-sales" },
    ]);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.key).toBe("sales");
  });
});
