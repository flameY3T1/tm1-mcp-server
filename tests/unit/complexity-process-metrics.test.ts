import { describe, it, expect } from "vitest";
import {
  computeProcessMetrics,
  computeTabMetrics,
} from "../../src/lib/complexity/process-metrics.js";

describe("computeTabMetrics", () => {
  it("counts loc, comments, blanks", () => {
    const src = `# header comment\n\nx = 1;\ny = 2;\n# trailing`;
    const m = computeTabMetrics(src);
    expect(m.loc).toBe(2);
    expect(m.commentLines).toBe(2);
    expect(m.blankLines).toBe(1);
  });

  it("counts a single IF as one branch with nesting depth 1", () => {
    const src = `IF(x=1);\n  y = 2;\nENDIF;`;
    const m = computeTabMetrics(src);
    expect(m.branches).toBe(1);
    expect(m.maxNesting).toBe(1);
  });

  it("counts ELSEIF clauses as additional branches", () => {
    const src = `IF(x=1);\n  a=1;\nELSEIF(x=2);\n  a=2;\nELSEIF(x=3);\n  a=3;\nELSE;\n  a=4;\nENDIF;`;
    const m = computeTabMetrics(src);
    expect(m.branches).toBe(3);
  });

  it("tracks max nesting depth across nested if/while", () => {
    const src = `IF(a=1);\n  WHILE(b<10);\n    IF(c=1);\n      x=1;\n    ENDIF;\n  END;\nENDIF;`;
    const m = computeTabMetrics(src);
    expect(m.maxNesting).toBe(3);
    expect(m.branches).toBe(3);
  });

  it("sets parseError true on malformed source but still counts raw lines", () => {
    const src = `IF(x=1);\n  unterminated`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(true);
    expect(m.loc).toBeGreaterThan(0);
  });

  it("returns zeros for empty source", () => {
    const m = computeTabMetrics("");
    expect(m.loc).toBe(0);
    expect(m.branches).toBe(0);
    expect(m.maxNesting).toBe(0);
    expect(m.parseError).toBe(false);
  });
});

describe("computeProcessMetrics", () => {
  it("aggregates totals across all four tabs", () => {
    const m = computeProcessMetrics("Load_Sales", {
      prolog: `x = 1;`,
      metadata: `# meta comment\ny = 2;`,
      data: `IF(z=1);\n  w=1;\nENDIF;`,
      epilog: ``,
    });
    expect(m.totals.loc).toBe(5);
    expect(m.totals.commentLines).toBe(1);
    expect(m.totals.branches).toBe(1);
    expect(m.totals.maxNesting).toBe(1);
    expect(m.totals.score).toBe(5 + 2 * 1 + 3 * 1);
  });

  it("computes commentRatio as comments / (loc+comments)", () => {
    const m = computeProcessMetrics("Doc", {
      prolog: `# a\n# b\nx=1;`,
      metadata: ``,
      data: ``,
      epilog: ``,
    });
    expect(m.totals.commentLines).toBe(2);
    expect(m.totals.loc).toBe(1);
    expect(m.totals.commentRatio).toBeCloseTo(2 / 3, 4);
  });

  it("commentRatio is 0 when process is empty", () => {
    const m = computeProcessMetrics("Empty", {
      prolog: ``,
      metadata: ``,
      data: ``,
      epilog: ``,
    });
    expect(m.totals.commentRatio).toBe(0);
    expect(m.totals.score).toBe(0);
  });

  it("preserves per-tab breakdown", () => {
    const m = computeProcessMetrics("Split", {
      prolog: `x=1;`,
      metadata: `y=2;\nz=3;`,
      data: ``,
      epilog: `a=1;\nb=2;\nc=3;`,
    });
    expect(m.tabs.prolog.loc).toBe(1);
    expect(m.tabs.metadata.loc).toBe(2);
    expect(m.tabs.data.loc).toBe(0);
    expect(m.tabs.epilog.loc).toBe(3);
  });
});
