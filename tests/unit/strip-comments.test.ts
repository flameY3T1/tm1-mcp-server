import { describe, it, expect } from "vitest";
import { commentStats, stripCommentBlocks, COLLAPSE_MIN } from "../../src/lib/strip-comments.js";

describe("commentStats", () => {
  it("counts total lines and full-line comments", () => {
    const src = ["# header", "x = 1;", "  # indented comment", "y = 2; # inline"].join("\n");
    expect(commentStats(src)).toEqual({ totalLines: 4, commentLines: 2 });
  });

  it("treats an inline trailing comment as code, not a comment line", () => {
    expect(commentStats("nValue = 5; # set value")).toEqual({ totalLines: 1, commentLines: 0 });
  });

  it("handles empty input", () => {
    expect(commentStats("")).toEqual({ totalLines: 0, commentLines: 0 });
  });
});

describe("stripCommentBlocks", () => {
  it("collapses a run of >= COLLAPSE_MIN comment lines into one marker", () => {
    const dead = Array.from({ length: 6 }, (_, i) => `# old line ${i}`);
    const src = ["x = 1;", ...dead, "y = 2;"].join("\n");
    const r = stripCommentBlocks(src);
    expect(r.collapsedBlocks).toBe(1);
    expect(r.removedLines).toBe(6);
    expect(r.code).toBe(["x = 1;", "# [... 6 lines commented out ...]", "y = 2;"].join("\n"));
  });

  it("keeps short comment runs (< COLLAPSE_MIN) verbatim", () => {
    const src = ["# doc 1", "# doc 2", "# doc 3", "x = 1;"].join("\n");
    expect(COLLAPSE_MIN).toBeGreaterThan(3);
    const r = stripCommentBlocks(src);
    expect(r.collapsedBlocks).toBe(0);
    expect(r.code).toBe(src);
  });

  it("keeps inline trailing comments", () => {
    const src = "nValue = 5; # important note";
    expect(stripCommentBlocks(src).code).toBe(src);
  });

  it("collapses multiple separate blocks", () => {
    const block = (n: number) => Array.from({ length: 5 }, (_, i) => `# block${n} line ${i}`);
    const src = ["a = 1;", ...block(1), "b = 2;", ...block(2), "c = 3;"].join("\n");
    const r = stripCommentBlocks(src);
    expect(r.collapsedBlocks).toBe(2);
    expect(r.removedLines).toBe(10);
    expect(r.code).toBe(
      ["a = 1;", "# [... 5 lines commented out ...]", "b = 2;", "# [... 5 lines commented out ...]", "c = 3;"].join("\n"),
    );
  });

  it("normalizes CRLF line endings to LF", () => {
    const src = ["x = 1;", "y = 2;"].join("\r\n");
    expect(stripCommentBlocks(src).code).toBe("x = 1;\ny = 2;");
  });

  it("handles empty input", () => {
    expect(stripCommentBlocks("")).toEqual({ code: "", removedLines: 0, collapsedBlocks: 0 });
  });
});
