import { describe, it, expect } from "vitest";
import {
  buildSampleCellsMdx,
  transformSampleCells,
} from "../../src/lib/sample-cells.js";
import type { MdxResult } from "../../src/types.js";

describe("buildSampleCellsMdx", () => {
  const baseDims = ["Version", "Year", "Account", "Measure"];

  it("default: HEAD(N) with NON EMPTY crossjoin, last dim on COLUMNS, leaves only", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 5,
      leavesOnly: true,
    });
    expect(r.columnDim).toBe("Measure");
    expect(r.rowDims).toEqual(["Version", "Year", "Account"]);
    expect(r.whereDims).toEqual([]);
    expect(r.mdx).toContain("HEAD(NONEMPTY(CROSSJOIN(");
    expect(r.mdx).toContain("TM1FILTERBYLEVEL({TM1SUBSETALL([Version])},0)");
    expect(r.mdx).toContain("TM1FILTERBYLEVEL({TM1SUBSETALL([Year])},0)");
    expect(r.mdx).toContain("TM1FILTERBYLEVEL({TM1SUBSETALL([Account])},0)");
    expect(r.mdx).toContain("{[Measure].DefaultMember} ON COLUMNS");
    expect(r.mdx).toContain(",5) ON ROWS");
    expect(r.mdx).toContain("FROM [Cube_X]");
    expect(r.mdx).not.toContain("WHERE (");
  });

  it("maxCells=0 omits HEAD()", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 0,
      leavesOnly: true,
    });
    expect(r.mdx).not.toContain("HEAD(");
    expect(r.mdx).toContain("NONEMPTY(CROSSJOIN(");
  });

  it("single-string filter -> WHERE pin, removes dim from CROSSJOIN", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 5,
      filters: { Version: "Plan" },
      leavesOnly: true,
    });
    expect(r.whereDims).toEqual(["Version"]);
    expect(r.rowDims).toEqual(["Year", "Account"]);
    expect(r.mdx).toContain("WHERE ([Version].[Plan])");
    expect(r.mdx).not.toContain("TM1FILTERBYLEVEL({TM1SUBSETALL([Version])}");
  });

  it("array filter -> axis member set replaces default leaf set", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 5,
      filters: { Year: ["2025", "2026"] },
      leavesOnly: true,
    });
    expect(r.whereDims).toEqual([]);
    expect(r.rowDims).toContain("Year");
    expect(r.mdx).toContain("{[Year].[2025],[Year].[2026]}");
    expect(r.mdx).not.toContain("TM1SUBSETALL([Year])");
  });

  it("axisDimension override + filter on column dim -> replaces COLUMNS set", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 5,
      axisDimension: "Account",
      filters: { Account: ["Sales", "COGS"] },
      leavesOnly: true,
    });
    expect(r.columnDim).toBe("Account");
    expect(r.rowDims).toContain("Measure");
    expect(r.rowDims).not.toContain("Account");
    expect(r.mdx).toContain("{[Account].[Sales],[Account].[COGS]} ON COLUMNS");
  });

  it("leavesOnly=false uses TM1SUBSETALL without level filter", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: baseDims,
      maxCells: 5,
      leavesOnly: false,
    });
    expect(r.mdx).toContain("{TM1SUBSETALL([Version])}");
    expect(r.mdx).not.toContain("TM1FILTERBYLEVEL");
  });

  it("escapes ']' in element names per MDX bracket rules", () => {
    const r = buildSampleCellsMdx({
      cubeName: "Cube_X",
      dimensions: ["Dim1", "Dim2"],
      maxCells: 5,
      filters: { Dim1: "weird]name" },
      leavesOnly: true,
    });
    expect(r.mdx).toContain("[Dim1].[weird]]name]");
  });

  it("rejects axisDimension not in cube dimensions", () => {
    expect(() =>
      buildSampleCellsMdx({
        cubeName: "Cube_X",
        dimensions: baseDims,
        maxCells: 5,
        axisDimension: "Unknown",
        leavesOnly: true,
      }),
    ).toThrow(/not a dimension of cube/);
  });

  it("rejects filter keys not in cube dimensions", () => {
    expect(() =>
      buildSampleCellsMdx({
        cubeName: "Cube_X",
        dimensions: baseDims,
        maxCells: 5,
        filters: { Foo: "bar" },
        leavesOnly: true,
      }),
    ).toThrow(/Filter dimension 'Foo'/);
  });
});

describe("transformSampleCells", () => {
  it("maps row+column tuple members + WHERE coords into per-cell coordinates", () => {
    const result: MdxResult = {
      cells: [
        { value: 1, formattedValue: "1" },
        { value: 2, formattedValue: "2" },
      ],
      axes: [
        { tuples: [{ members: [{ name: "Measure_A", hierarchyName: "Measure" }] }] },
        {
          tuples: [
            {
              members: [
                { name: "2025", hierarchyName: "Year" },
                { name: "Sales", hierarchyName: "Account" },
              ],
            },
            {
              members: [
                { name: "2026", hierarchyName: "Year" },
                { name: "Sales", hierarchyName: "Account" },
              ],
            },
          ],
        },
      ],
      totalCellCount: 2,
    };

    const cells = transformSampleCells({
      result,
      whereCoords: { Version: "Plan" },
    });

    expect(cells).toHaveLength(2);
    expect(cells[0].coordinates).toEqual({
      Version: "Plan",
      Measure: "Measure_A",
      Year: "2025",
      Account: "Sales",
    });
    expect(cells[0].value).toBe(1);
    expect(cells[1].coordinates.Year).toBe("2026");
    expect(cells[1].value).toBe(2);
  });

  it("returns empty array when no cells", () => {
    const cells = transformSampleCells({
      result: { cells: [], axes: [], totalCellCount: 0 },
      whereCoords: {},
    });
    expect(cells).toEqual([]);
  });
});
