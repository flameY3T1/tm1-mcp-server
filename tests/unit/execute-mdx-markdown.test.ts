import { describe, expect, it } from "vitest";
import { renderMdxMarkdown } from "../../src/tools/celldata/execute-mdx.js";

const member = (name: string, hierarchyName = "H") => ({ name, hierarchyName });
const tuple = (...names: string[]) => ({ members: names.map((n) => member(n)) });
const cell = (formattedValue: string, value: number | string | null = 0) => ({
  value,
  formattedValue,
});

describe("renderMdxMarkdown", () => {
  it("renders a 2-axis full result as a pivot grid (axis0=cols, axis1=rows, axis0 fastest)", () => {
    // 2 columns (Jan, Feb) × 2 rows (Plan, Actual). Cells ordered axis0-fastest:
    // [Plan/Jan, Plan/Feb, Actual/Jan, Actual/Feb]
    const env = {
      axes: [
        { tuples: [tuple("Jan"), tuple("Feb")] },
        { tuples: [tuple("Plan"), tuple("Actual")] },
      ],
      total: 4,
      count: 4,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [cell("10"), cell("20"), cell("11"), cell("22")],
    };
    const md = renderMdxMarkdown(env);
    expect(md).toContain("| H | Jan | Feb |");
    expect(md).toContain("| Plan | 10 | 20 |");
    expect(md).toContain("| Actual | 11 | 22 |");
  });

  it("renders a grid when extra axes are single-tuple context (TM1 WHERE axis)", () => {
    // TM1 surfaces the WHERE clause as a trailing single-tuple axis. axis0=cols,
    // axis1=rows, axis2=context (1 tuple) → still a clean grid, ×1 multiplier.
    const env = {
      axes: [
        { tuples: [tuple("Jan"), tuple("Feb")] },
        { tuples: [tuple("Plan"), tuple("Actual")] },
        { tuples: [{ members: [member("Actual", "Version"), member("EUR", "Currency")] }] },
      ],
      total: 4,
      count: 4,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [cell("10"), cell("20"), cell("11"), cell("22")],
    };
    const md = renderMdxMarkdown(env);
    expect(md).toContain("**Context:** Actual / EUR");
    expect(md).toContain("| H | Jan | Feb |");
    expect(md).toContain("| Plan | 10 | 20 |");
    expect(md).toContain("| Actual | 11 | 22 |");
  });

  it("falls back to a flat coordinate table for a genuine 3-D result", () => {
    const env = {
      axes: [
        { tuples: [tuple("Jan"), tuple("Feb")] },
        { tuples: [tuple("Plan")] },
        { tuples: [tuple("EU"), tuple("US")] },
      ],
      total: 4,
      count: 4,
      offset: 0,
      has_more: false,
      next_offset: null,
      // axis0 fastest, then axis1, then axis2:
      // EU/Plan/Jan, EU/Plan/Feb, US/Plan/Jan, US/Plan/Feb
      items: [cell("1"), cell("2"), cell("3"), cell("4")],
    };
    const md = renderMdxMarkdown(env);
    expect(md).toContain("| H | H | H | Value |");
    expect(md).toContain("| Jan | Plan | EU | 1 |");
    expect(md).toContain("| Feb | Plan | EU | 2 |");
    expect(md).toContain("| Jan | Plan | US | 3 |");
    expect(md).toContain("| Feb | Plan | US | 4 |");
  });

  it("falls back to flat table when a 2-axis result is paginated (offset>0)", () => {
    const env = {
      axes: [
        { tuples: [tuple("Jan"), tuple("Feb")] },
        { tuples: [tuple("Plan"), tuple("Actual")] },
      ],
      total: 4,
      count: 2,
      offset: 2,
      has_more: false,
      next_offset: null,
      // global ordinals 2,3 → Actual/Jan, Actual/Feb
      items: [cell("11"), cell("22")],
    };
    const md = renderMdxMarkdown(env);
    expect(md).toContain("offset 2");
    expect(md).toContain("| Jan | Actual | 11 |");
    expect(md).toContain("| Feb | Actual | 22 |");
  });

  it("prefers formattedValue, falls back to raw value when formatted is empty", () => {
    const env = {
      axes: [{ tuples: [tuple("Jan")] }],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ value: 42, formattedValue: "" }],
    };
    const md = renderMdxMarkdown(env);
    expect(md).toContain("| Jan | 42 |");
  });

  it("renders a scalar (no axes) and an empty cellset", () => {
    expect(
      renderMdxMarkdown({
        axes: [],
        total: 1,
        count: 1,
        offset: 0,
        has_more: false,
        next_offset: null,
        items: [cell("99")],
      }),
    ).toContain("**Value:** 99");
    expect(
      renderMdxMarkdown({
        axes: [],
        total: 0,
        count: 0,
        offset: 0,
        has_more: false,
        next_offset: null,
        items: [],
      }),
    ).toContain("(no cells)");
  });

  it("escapes pipe characters in member names", () => {
    const env = {
      axes: [{ tuples: [{ members: [member("A|B")] }] }],
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [cell("5")],
    };
    expect(renderMdxMarkdown(env)).toContain("A\\|B");
  });
});
