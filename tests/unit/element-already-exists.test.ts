import { describe, it, expect } from "vitest";
import { isAlreadyExists } from "../../src/tm1-client/services/element-service.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// Pins the cross-version "element already exists" classification (de8c806): TM1
// v11.x returns HTTP 400 with an "already exists" message where later versions
// return 409. bulkUpsert relies on this to stay idempotent — a mutation of the
// condition (e.g. dropping the 400 branch, or the substring match) would slip
// past every gate because it was only covered by the live suite, which CI never
// runs. This is that missing CI pin.
function err(opts: {
  httpStatus?: number;
  message?: string;
  details?: string;
}): TM1Error {
  return new TM1Error({
    code: TM1ErrorCode.TM1_ERROR,
    message: opts.message ?? "error",
    httpStatus: opts.httpStatus,
    details: opts.details,
  });
}

describe("isAlreadyExists", () => {
  it("treats HTTP 409 Conflict as already-exists", () => {
    expect(isAlreadyExists(err({ httpStatus: 409 }))).toBe(true);
  });

  it("treats HTTP 400 with an 'already exists' message as already-exists (v11.x)", () => {
    expect(
      isAlreadyExists(
        err({
          httpStatus: 400,
          message: "An element with name 'Region' already exists",
        }),
      ),
    ).toBe(true);
  });

  it("matches the 'already exists' text in details, not just message", () => {
    expect(
      isAlreadyExists(
        err({
          httpStatus: 400,
          message: "Bad Request",
          details: "An element with that name already exists.",
        }),
      ),
    ).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    expect(
      isAlreadyExists(err({ httpStatus: 400, message: "ALREADY EXISTS" })),
    ).toBe(true);
  });

  it("does NOT treat an unrelated HTTP 400 as already-exists", () => {
    expect(
      isAlreadyExists(
        err({ httpStatus: 400, message: "Invalid element type ordinal" }),
      ),
    ).toBe(false);
  });

  it("does NOT treat HTTP 404 as already-exists", () => {
    expect(
      isAlreadyExists(err({ httpStatus: 404, message: "already exists" })),
    ).toBe(false);
  });
});
