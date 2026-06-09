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

  it("parses bedrock-style condensed multi-statement lines", () => {
    const src = `IF(x=1);y=2;ENDIF;`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(false);
    expect(m.branches).toBe(1);
    expect(m.maxNesting).toBe(1);
  });

  it("does not split semicolons inside single-quoted strings", () => {
    const src = `s = 'a;b;c';\nx = 1;`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(false);
    expect(m.loc).toBe(2);
  });

  it("counts nested while+if on single condensed line", () => {
    const src = `WHILE(n<10);IF(n=5);x=1;ENDIF;n=n+1;END;`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(false);
    expect(m.branches).toBe(2);
    expect(m.maxNesting).toBe(2);
  });

  it("preserves raw line counts (LOC) when source is condensed", () => {
    const src = `IF(x=1);y=2;ENDIF;`;
    const m = computeTabMetrics(src);
    expect(m.loc).toBe(1);
    expect(m.blankLines).toBe(0);
  });

  it("handles CRLF line endings without injecting stray newlines", () => {
    const src = `IF(x=1);\r\n  y=2;\r\nENDIF;\r\n`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(false);
    expect(m.branches).toBe(1);
    expect(m.maxNesting).toBe(1);
    expect(m.loc).toBe(3);
    expect(m.blankLines).toBe(1);
  });

  it("handles CRLF condensed multi-statement lines (bedrock + Windows export)", () => {
    const src = `IF(x=1);y=2;ENDIF;\r\nz=3;\r\n`;
    const m = computeTabMetrics(src);
    expect(m.parseError).toBe(false);
    expect(m.branches).toBe(1);
    expect(m.maxNesting).toBe(1);
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

// ---------------------------------------------------------------------------
// Scoring v2: cognitive-style cost. Loop nesting multiplies (M^depth), if cost
// scales with condition complexity and nesting, hot ops in loops penalized.
// v1 `score` / `branches` / `maxNesting` stay unchanged (regression-guarded).
// Defaults: LOOP_BASE=2, NEST_MULT=3, IF_BASE=1, HOT_PENALTY=2, discountMax=0.
// ---------------------------------------------------------------------------
describe("computeTabMetrics v2 cost", () => {
  it("multiplies loop cost by NEST_MULT^loopDepth for nested whiles", () => {
    const src = `WHILE(a<1);\n  WHILE(b<1);\n    WHILE(c<1);\n      x=1;\n    END;\n  END;\nEND;`;
    const m = computeTabMetrics(src);
    // 2*3^0 + 2*3^1 + 2*3^2 = 2 + 6 + 18
    expect(m.loopCost).toBe(26);
  });

  it("adds sibling loops at the same depth linearly", () => {
    const src = `WHILE(a<1);\n  x=1;\nEND;\nWHILE(b<1);\n  y=1;\nEND;`;
    const m = computeTabMetrics(src);
    // 2*3^0 + 2*3^0
    expect(m.loopCost).toBe(4);
  });

  it("scales ifCost by condition complexity (AND/OR connectors)", () => {
    const simple = computeTabMetrics(`IF(x=1);\n  a=1;\nENDIF;`);
    const compound = computeTabMetrics(`IF(a=1 & b=2 % c=3);\n  a=1;\nENDIF;`);
    // simple: IF_BASE * 1 * (1+0) = 1
    expect(simple.ifCost).toBe(1);
    // compound: 1 + 2 connectors = 3 clauses; 1 * 3 * (1+0) = 3
    expect(compound.ifCost).toBe(3);
  });

  it("scales ifCost by if-nesting depth", () => {
    const src = `IF(a=1);\n  IF(b=1);\n    x=1;\n  ENDIF;\nENDIF;`;
    const m = computeTabMetrics(src);
    // outer: 1*1*(1+0)=1 ; inner: 1*1*(1+1)=2
    expect(m.ifCost).toBe(3);
  });

  it("does not count AND/OR chars inside string literals", () => {
    const m = computeTabMetrics(`IF(s @= 'A&B%C');\n  a=1;\nENDIF;`);
    // no real connectors -> complexity 1 -> ifCost 1
    expect(m.ifCost).toBe(1);
  });

  it("penalizes hot ops inside loops by loop depth", () => {
    const src = `WHILE(a<1);\n  CellPutN(1, 'C', 'e');\n  WHILE(b<1);\n    CellPutN(2, 'C', 'e');\n  END;\nEND;`;
    const m = computeTabMetrics(src);
    // depth1 CellPutN: 2*1 ; depth2 CellPutN: 2*2
    expect(m.hotInLoop).toBe(6);
  });

  it("does not penalize hot ops outside any loop", () => {
    const m = computeTabMetrics(`CellPutN(1, 'C', 'e');\nx=1;`);
    expect(m.hotInLoop).toBe(0);
  });

  it("zeroes v2 costs on parse error but keeps loc", () => {
    const m = computeTabMetrics(`WHILE(a<1);\n  unterminated`);
    expect(m.parseError).toBe(true);
    expect(m.loopCost).toBe(0);
    expect(m.ifCost).toBe(0);
    expect(m.hotInLoop).toBe(0);
    expect(m.loc).toBeGreaterThan(0);
  });

  it("honors custom weights", () => {
    const src = `WHILE(a<1);\n  WHILE(b<1);\n    x=1;\n  END;\nEND;`;
    const m = computeTabMetrics(src, { loopBase: 1, nestMult: 10 });
    // 1*10^0 + 1*10^1 = 11
    expect(m.loopCost).toBe(11);
  });
});

describe("computeProcessMetrics v2 score", () => {
  it("aggregates scoreV2 = loc + ifCost + loopCost + hotInLoop across tabs", () => {
    const m = computeProcessMetrics("V2", {
      prolog: `IF(x=1);\n  a=1;\nENDIF;`,
      metadata: ``,
      data: `WHILE(a<1);\n  CellPutN(1,'C','e');\nEND;`,
      epilog: ``,
    });
    // prolog: loc=3 ifCost=1 ; data: loc=3 loopCost=2 hotInLoop=2
    expect(m.totals.ifCost).toBe(1);
    expect(m.totals.loopCost).toBe(2);
    expect(m.totals.hotInLoop).toBe(2);
    expect(m.totals.scoreV2).toBe(6 + 1 + 2 + 2);
  });

  it("leaves v1 score untouched by v2 additions", () => {
    const m = computeProcessMetrics("Compat", {
      prolog: `IF(z=1);\n  w=1;\nENDIF;`,
      metadata: ``,
      data: ``,
      epilog: ``,
    });
    expect(m.totals.score).toBe(3 + 2 * 1 + 3 * 1);
  });

  it("applies comment discount to scoreV2 only when opted in", () => {
    const code = {
      prolog: `# doc\n# doc\nWHILE(a<1);\n  x=1;\nEND;`,
      metadata: ``,
      data: ``,
      epilog: ``,
    };
    const off = computeProcessMetrics("D", code);
    const on = computeProcessMetrics("D", code, { commentDiscountMax: 0.3 });
    expect(on.totals.scoreV2).toBeLessThan(off.totals.scoreV2);
  });
});
