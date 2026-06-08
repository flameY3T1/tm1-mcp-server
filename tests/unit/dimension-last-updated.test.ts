import { describe, it, expect } from "vitest";
import {
  decodeTm1Timestamp,
  normalizeChangedSince,
} from "../../src/tm1-client/services/dimension-service.js";

describe("decodeTm1Timestamp", () => {
  it("decodes a 14-digit YYYYMMDDHHMMSS stamp to naive-local ISO", () => {
    expect(decodeTm1Timestamp("20260608165912")).toBe("2026-06-08T16:59:12");
  });

  it("returns null for blank / missing", () => {
    expect(decodeTm1Timestamp("")).toBeNull();
    expect(decodeTm1Timestamp(null)).toBeNull();
    expect(decodeTm1Timestamp(undefined)).toBeNull();
  });

  it("returns null for non-conforming input (not 14 digits)", () => {
    expect(decodeTm1Timestamp("2026")).toBeNull();
    expect(decodeTm1Timestamp("0")).toBeNull();
    expect(decodeTm1Timestamp("not-a-date")).toBeNull();
  });

  it("accepts a numeric cell value", () => {
    expect(decodeTm1Timestamp(20260401082819)).toBe("2026-04-01T08:28:19");
  });

  it("does NOT append a Z (value is server-local, not UTC)", () => {
    expect(decodeTm1Timestamp("20260101000000")).not.toContain("Z");
  });
});

describe("normalizeChangedSince", () => {
  it("pads a date-only input to start-of-day 14 digits", () => {
    expect(normalizeChangedSince("2026-04-01")).toBe("20260401000000");
  });

  it("normalizes a full datetime (T separator)", () => {
    expect(normalizeChangedSince("2026-04-01T08:30:15")).toBe("20260401083015");
  });

  it("normalizes a partial time (HH:MM) by padding seconds", () => {
    expect(normalizeChangedSince("2026-04-01T08:30")).toBe("20260401083000");
  });

  it("tolerates a space separator", () => {
    expect(normalizeChangedSince("2026-04-01 08:30:15")).toBe("20260401083015");
  });

  it("throws on fewer than 8 date digits", () => {
    expect(() => normalizeChangedSince("2026-04")).toThrow();
    expect(() => normalizeChangedSince("garbage")).toThrow();
  });

  it("compares correctly against a raw stamp via string ordering", () => {
    const since = normalizeChangedSince("2026-04-01");
    expect("20260401082819" >= since).toBe(true);
    expect("20260331235959" >= since).toBe(false);
  });
});
