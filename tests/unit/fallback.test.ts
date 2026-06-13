import { describe, it, expect } from "vitest";
import { rethrowIfSystemic } from "../../src/tm1-client/services/fallback.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

describe("rethrowIfSystemic", () => {
  it("swallows expected, handleable codes so the caller's fallback proceeds", () => {
    for (const code of [
      TM1ErrorCode.NOT_FOUND,
      TM1ErrorCode.PERMISSION_DENIED,
      TM1ErrorCode.TM1_ERROR,
      TM1ErrorCode.UNSUPPORTED_OPERATION,
      TM1ErrorCode.CONFLICT,
      TM1ErrorCode.VALIDATION_ERROR,
    ] as const) {
      expect(() => rethrowIfSystemic(new TM1Error({ code, message: "x" }))).not.toThrow();
    }
  });

  it("rethrows systemic transport/auth codes (never masked by a fallback)", () => {
    for (const code of [
      TM1ErrorCode.AUTH_FAILED,
      TM1ErrorCode.CONNECTION_FAILED,
      TM1ErrorCode.LOCK_TIMEOUT,
    ] as const) {
      const err = new TM1Error({ code, message: "x" });
      expect(() => rethrowIfSystemic(err)).toThrow(err);
    }
  });

  it("rethrows non-TM1Error (unexpected throws are never swallowed)", () => {
    const err = new TypeError("boom");
    expect(() => rethrowIfSystemic(err)).toThrow(err);
  });
});
