import { describe, it, expect } from "vitest";
import { lintProcess } from "../../src/lib/complexity/antipatterns.js";
import {
  computeTabMetrics,
  splitMultiStatementLines,
} from "../../src/lib/complexity/process-metrics.js";

// Bedrock-style code packs several statements onto one line. The lint has to
// read such a tab the way the metrics do, and report the line the author sees.
const dead = (src: string) =>
  lintProcess("zzLoad", { prolog: "", metadata: src, data: "", epilog: "" })
    .filter((f) => f.rule === "dead-assignment")
    .map((f) => [f.snippet.split(" ")[0], f.line]);

describe("condensed lines: lint", () => {
  it("sees every assignment on a line with several statements", () => {
    expect(dead("a=1; b=2;")).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
  });

  it("lints an IF/ELSE condensed onto one line", () => {
    expect(dead("IF(x=1); v=1; ELSE; v=2; ENDIF;")).toEqual([["v", 1]]);
  });

  it("reports the source line for statements after a condensed line", () => {
    expect(dead("z=0;\nIF(a=1); v=1; ENDIF; w=2;\n\nq=3;")).toEqual([
      ["z", 1],
      ["v", 2],
      ["w", 2],
      ["q", 4],
    ]);
  });

  it("finds the same as in the expanded form", () => {
    const names = (src: string) => dead(src).map(([name]) => name);
    expect(names("IF(x=1); v=1; ELSE; w=2; ENDIF;")).toEqual(
      names("IF(x=1);\n v=1;\nELSE;\n w=2;\nENDIF;"),
    );
  });
});

describe("splitMultiStatementLines", () => {
  it("maps every line of the split text to its source line", () => {
    const { text, lineOrigin } = splitMultiStatementLines(
      "a=1; b=2;\n# c; d;\ns='x;y'; e=3;",
    );
    expect(text.split("\n")).toEqual([
      "a=1;",
      " b=2;",
      "# c; d;",
      "s='x;y';",
      " e=3;",
    ]);
    expect(lineOrigin).toEqual([0, 0, 1, 2, 2]);
  });

  it("leaves the metrics of a condensed tab unchanged", () => {
    const m = computeTabMetrics(
      "IF(x=1); a=1; ELSEIF(y=2); a=2; ELSE; a=3; ENDIF;",
    );
    expect(m.parseError).toBe(false);
    expect(m.branches).toBe(2);
  });
});
