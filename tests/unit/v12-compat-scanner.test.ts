import { describe, it, expect } from "vitest";
import { scanForDeprecatedTi } from "../../src/lib/v12-compat/scanner.js";
import { V12_DEPRECATED_TI } from "../../src/lib/v12-compat/deprecated-ti.js";

describe("v12 deprecation scanner", () => {
  it("detects a single deprecated call with correct line and casing", () => {
    const src = [
      "# warm-up",
      "sVal = 'x';",
      "SaveDataAll();",
      "sOther = 'y';",
    ].join("\n");
    const hits = scanForDeprecatedTi(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].function).toBe("SaveDataAll");
    expect(hits[0].severity).toBe("error");
  });

  it("is case-insensitive (TI semantics)", () => {
    const hits = scanForDeprecatedTi("savedataall();");
    expect(hits).toHaveLength(1);
    expect(hits[0].function).toBe("SaveDataAll");
  });

  it("skips full-line comments", () => {
    const src = [
      "# SaveDataAll() called here would be ignored",
      "  # ServerShutdown();",
    ].join("\n");
    expect(scanForDeprecatedTi(src)).toEqual([]);
  });

  it("deduplicates repeats of the same call on the same line", () => {
    const hits = scanForDeprecatedTi("SaveDataAll(); SaveDataAll();");
    expect(hits).toHaveLength(1);
  });

  it("does not flag non-deprecated functions", () => {
    const src = [
      "CellPutN(0, 'Sales', '2026', 'Actual');",
      "DimensionElementInsert('Region', '', 'North', 'N');",
    ].join("\n");
    expect(scanForDeprecatedTi(src)).toEqual([]);
  });

  it("returns an entry for every deprecated function in the canonical list", () => {
    for (const entry of V12_DEPRECATED_TI.values()) {
      const hits = scanForDeprecatedTi(`${entry.name}();`);
      expect(hits, `expected to match ${entry.name}`).toHaveLength(1);
      expect(hits[0].function).toBe(entry.name);
    }
  });
});
