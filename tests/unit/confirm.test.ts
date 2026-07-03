import { describe, it, expect } from "vitest";
import { requireConfirm, CONFIRM_SCHEMA } from "../../src/tools/confirm.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

describe("requireConfirm", () => {
  it("passes when the provided value matches the target verbatim", () => {
    expect(() => requireConfirm("SalesCube", "SalesCube", "cube")).not.toThrow();
  });

  it("throws VALIDATION_ERROR on a mismatch", () => {
    try {
      requireConfirm("salescube", "SalesCube", "cube");
      expect.unreachable("should have thrown on case mismatch");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
      expect((e as TM1Error).message).toContain("SalesCube");
    }
  });

  it("throws on an empty confirm value when the target is non-empty", () => {
    expect(() => requireConfirm("", "SalesCube", "cube")).toThrow(TM1Error);
  });

  it("is not satisfied by a whitespace-padded value", () => {
    // Guards against a future refactor that trims/normalises and weakens the check.
    expect(() => requireConfirm("SalesCube ", "SalesCube", "cube")).toThrow(TM1Error);
  });

  it("exposes a required string `confirm` field in CONFIRM_SCHEMA", () => {
    const parsed = CONFIRM_SCHEMA.confirm.safeParse(undefined);
    expect(parsed.success).toBe(false); // required, not optional
    expect(CONFIRM_SCHEMA.confirm.safeParse("x").success).toBe(true);
  });
});
