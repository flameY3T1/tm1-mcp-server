import { describe, it, expect } from "vitest";
import { extractErrorFile } from "../../src/tm1-client/services/server-service.js";

describe("extractErrorFile", () => {
  it("extracts a filename wrapped in angle brackets (German locale)", () => {
    const msg =
      'Prozess "ti_Util_RebuildFeeders": : Die Ausführung wurde abgebrochen. ' +
      "Fehlerdatei: <TM1ProcessError_20260426092744_02805036_ti_Util_RebuildFeeders.log> : " +
      'Cube "" wurde nicht gefunden';
    expect(extractErrorFile(msg)).toBe(
      "TM1ProcessError_20260426092744_02805036_ti_Util_RebuildFeeders.log",
    );
  });

  it("extracts a bare TM1ProcessError filename without angle brackets", () => {
    const msg =
      "Process LoadActuals aborted, see TM1ProcessError_20260513174354_81004880_LoadActuals_mp4clzmld56v.log for details";
    expect(extractErrorFile(msg)).toBe(
      "TM1ProcessError_20260513174354_81004880_LoadActuals_mp4clzmld56v.log",
    );
  });

  it("does not include the closing angle bracket in the result", () => {
    const out = extractErrorFile("Fehlerdatei: <TM1ProcessError_20260615123045_42_LoadActuals.log>");
    expect(out).toBe("TM1ProcessError_20260615123045_42_LoadActuals.log");
    expect(out?.endsWith(".log")).toBe(true);
  });

  it("returns undefined when no error file is referenced", () => {
    expect(extractErrorFile("Server startup complete.")).toBeUndefined();
    expect(extractErrorFile("Garbage collection ran for 12ms")).toBeUndefined();
  });

  it("returns undefined for an empty message", () => {
    expect(extractErrorFile("")).toBeUndefined();
  });
});
