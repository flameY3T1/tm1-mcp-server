import { describe, it, expect } from "vitest";
import { extractSubsetUsage } from "../../src/lib/callgraph/subsetUsage.js";

describe("extractSubsetUsage", () => {
  it("links subset view via ViewSubsetAssign", () => {
    const u = extractSubsetUsage("ViewSubsetAssign('Sales','vTmp','Currency','sTmp');");
    expect(u.get("stmp")?.views).toEqual([{ view: "vTmp", cube: "Sales", zeroOut: false }]);
  });
  it("marks zero-out when assigned view is ViewZeroOut'd", () => {
    const u = extractSubsetUsage(
      "ViewSubsetAssign('Sales','vTmp','Currency','sTmp');\nViewZeroOut('Sales','vTmp');",
    );
    expect(u.get("stmp")?.views[0]?.zeroOut).toBe(true);
  });
  it("detects a loop read: SubsetGetElementName + CellGetN", () => {
    const u = extractSubsetUsage(
      "sEl=SubsetGetElementName('sTmp','Currency',1);\nnV=CellGetN('Sales',sEl);",
    );
    expect(u.get("stmp")?.loopRead).toBe(true);
    expect(u.get("stmp")?.loopWrite).toBe(false);
  });
  it("detects a loop write and a literal-zero as loopZero", () => {
    const u = extractSubsetUsage(
      "sEl=SubsetGetElementName('sTmp','Currency',1);\nCellPutN(0,'Sales',sEl);",
    );
    expect(u.get("stmp")?.loopWrite).toBe(true);
    expect(u.get("stmp")?.loopZero).toBe(true);
  });
  it("flags an unresolved subset handle without guessing", () => {
    const u = extractSubsetUsage("ViewSubsetAssign('Sales','vTmp','Currency',pSub);");
    const only = [...u.values()][0]!;
    expect(only.resolved).toBe(false);
  });
});
