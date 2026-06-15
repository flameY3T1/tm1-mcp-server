import { describe, it, expect } from "vitest";
import { parseLogName, formatTs, spanDays } from "../../src/tools/operations/list-error-logs.js";

describe("parseLogName", () => {
  it("parses modern v11 pattern with session hash", () => {
    expect(parseLogName("TM1ProcessError_20260615123045_42_LoadActuals_a1b2c3.log")).toEqual({
      ts: "20260615123045",
      process: "LoadActuals",
    });
  });

  it("parses modern v11 pattern without hash", () => {
    expect(parseLogName("TM1ProcessError_20260615123045_42_LoadActuals.log")).toEqual({
      ts: "20260615123045",
      process: "LoadActuals",
    });
  });

  it("keeps underscores inside the process name (strips only the hash)", () => {
    expect(parseLogName("TM1ProcessError_20260615123045_7_Sales_Load_Daily_deadbeef.log")).toEqual({
      ts: "20260615123045",
      process: "Sales_Load_Daily",
    });
  });

  it("parses legacy <proc>_<ts> pattern", () => {
    expect(parseLogName("MyProc_20260615123045.log")).toEqual({
      ts: "20260615123045",
      process: "MyProc",
    });
  });

  it("returns nulls for an unrecognised filename", () => {
    expect(parseLogName("random.txt")).toEqual({ process: null, ts: null });
  });
});

describe("formatTs", () => {
  it("formats a full 14-digit timestamp", () => {
    expect(formatTs("20260615123045")).toBe("2026-06-15T12:30:45");
  });

  it("pads missing time components for an 8-digit date", () => {
    expect(formatTs("20260615")).toBe("2026-06-15T00:00:00");
  });

  it("returns null for null or too-short input", () => {
    expect(formatTs(null)).toBeNull();
    expect(formatTs("2026")).toBeNull();
  });
});

describe("spanDays", () => {
  it("is 1 for the same day", () => {
    expect(spanDays("20260615000000", "20260615235959")).toBe(1);
  });

  it("counts inclusive whole days across a range", () => {
    expect(spanDays("20260601000000", "20260605000000")).toBe(5);
  });

  it("falls back to 1 on unparseable input", () => {
    expect(spanDays("bogus", "20260605000000")).toBe(1);
  });
});
