import { describe, expect, it } from "vitest";
import {
  formatTm1ErrorResult,
  normalizeErrorResult,
} from "../../src/tools/error-format.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

function parsePayload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("formatTm1ErrorResult", () => {
  it("wraps a TM1Error into a uniform isError result with hint", () => {
    const err = new TM1Error({
      code: TM1ErrorCode.NOT_FOUND,
      message: "Cube not found",
      httpStatus: 404,
      endpoint: "/api/v1/Cubes('Sales')",
    });

    const result = formatTm1ErrorResult(err);
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("NOT_FOUND");
    expect(payload.message).toBe("Cube not found");
    expect(payload.httpStatus).toBe(404);
    expect(payload.endpoint).toBe("/api/v1/Cubes('Sales')");
    expect(payload.hint).toContain("list_");
  });

  it("wraps a generic Error with the default TM1_ERROR code and hint", () => {
    const result = formatTm1ErrorResult(new Error("boom"));
    const payload = parsePayload(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("TM1_ERROR");
    expect(payload.message).toBe("boom");
    expect(typeof payload.hint).toBe("string");
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it("handles non-Error throws via String coercion", () => {
    const payload = parsePayload(formatTm1ErrorResult("string thrown"));
    expect(payload.message).toBe("string thrown");
    expect(payload.code).toBe("TM1_ERROR");
  });
});

describe("normalizeErrorResult", () => {
  it("adds hint to JSON payloads that already carry a code", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "PERMISSION_DENIED", message: "no" }),
        },
      ],
    });
    const payload = parsePayload(result);

    expect(payload.code).toBe("PERMISSION_DENIED");
    expect(payload.hint).toContain("rights");
  });

  it("preserves extra fields attached by tools (e.g. partialApply)", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "CONFLICT",
            message: "version mismatch",
            partialApply: true,
            failedStep: "compile",
          }),
        },
      ],
    });
    const payload = parsePayload(result);

    expect(payload.partialApply).toBe(true);
    expect(payload.failedStep).toBe("compile");
    expect(payload.hint.length).toBeGreaterThan(0);
  });

  it("wraps plain-text error bodies into the uniform shape", () => {
    const result = normalizeErrorResult({
      isError: true,
      content: [{ type: "text", text: "TM1 error: kaputt" }],
    });
    const payload = parsePayload(result);

    expect(payload.code).toBe("TM1_ERROR");
    expect(payload.message).toBe("kaputt");
    expect(payload.hint).toBeTruthy();
  });

  it("returns the result untouched when content is missing or non-text", () => {
    const empty = { isError: true, content: [] };
    expect(normalizeErrorResult(empty)).toEqual(empty);
  });
});
