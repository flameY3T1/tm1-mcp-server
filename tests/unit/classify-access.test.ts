import { describe, it, expect } from "vitest";
import { classifyAccess } from "../../src/lib/callgraph/callGraph.js";

describe("classifyAccess", () => {
  it("classifies cube cell writes", () => {
    for (const f of ["CellPutN", "CellPutS", "CellIncrementN", "CubeClearData", "ViewZeroOut"]) {
      expect(classifyAccess(f, "process")).toBe("write");
    }
  });

  it("classifies cube cell reads", () => {
    for (const f of ["CellGetN", "CellGetS", "DB"]) {
      expect(classifyAccess(f, "process")).toBe("read");
    }
  });

  it("classifies element/dimension attribute value writes", () => {
    for (const f of ["AttrPutN", "AttrPutS", "ElementAttrPutN", "ElementAttrPutS", "CubeAttrPutN"]) {
      expect(classifyAccess(f, "process")).toBe("write");
    }
  });

  it("classifies element/dimension attribute value reads", () => {
    for (const f of ["ATTRN", "ATTRS", "AttrNL", "AttrSL", "ElementAttrN", "ElementAttrS", "ElementAttrNL", "ElementAttrSL"]) {
      expect(classifyAccess(f, "process")).toBe("read");
    }
  });

  it("does not classify invented cube/view cell functions (no such TI fns)", () => {
    for (const f of ["CubePutN", "CubePutS", "ViewPutN", "ViewPutS", "CubeGetN", "ViewGetN", "AttributeGet", "AttributePut"]) {
      expect(classifyAccess(f, "process")).toBe("other");
    }
  });

  it("leaves attribute schema ops (insert/delete/create) unclassified", () => {
    for (const f of ["AttrInsert", "AttrDelete", "AttributeCreate", "ElementAttrInsert"]) {
      expect(classifyAccess(f, "process")).toBe("other");
    }
  });

  it("treats any rule-sourced reference as a read", () => {
    expect(classifyAccess(undefined, "rule")).toBe("read");
    expect(classifyAccess("DB", "rule")).toBe("read");
  });

  it("is case-insensitive on the function name", () => {
    expect(classifyAccess("cellputn", "process")).toBe("write");
    expect(classifyAccess("ELEMENTATTRN", "process")).toBe("read");
  });
});
