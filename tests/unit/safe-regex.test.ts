import { describe, it, expect } from "vitest";
import { compileUserRegex } from "../../src/lib/safe-regex.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

describe("compileUserRegex", () => {
  it("compiles a safe pattern and applies flags", () => {
    const re = compileUserRegex("^cube_[0-9]+$", "i", "nameRegex");
    expect(re).toBeInstanceOf(RegExp);
    expect(re.flags).toBe("i");
    expect(re.test("CUBE_42")).toBe(true);
    expect(re.test("nope")).toBe(false);
  });

  it("rejects catastrophic-backtracking patterns (ReDoS) as VALIDATION_ERROR", () => {
    try {
      compileUserRegex("(a+)+$", undefined, "pattern");
      throw new Error("expected compileUserRegex to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
      expect((e as TM1Error).message).toMatch(/backtracking|ReDoS/i);
    }
  });

  it("rejects unparseable patterns as VALIDATION_ERROR", () => {
    try {
      compileUserRegex("([unbalanced", undefined, "nameRegex");
      throw new Error("expected compileUserRegex to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TM1Error);
      expect((e as TM1Error).code).toBe(TM1ErrorCode.VALIDATION_ERROR);
    }
  });
});
