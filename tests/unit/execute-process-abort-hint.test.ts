import { describe, it, expect } from "vitest";
import { abortHint } from "../../src/tools/ti-development/execute-process.js";

describe("abortHint", () => {
  it("points jobs on v12", () => {
    const h = abortHint(12);
    expect(h).toContain("tm1_list_jobs");
    expect(h).toContain("tm1_cancel_job");
    expect(h).not.toContain("tm1_list_threads");
  });
  it("points threads on v11", () => {
    const h = abortHint(11);
    expect(h).toContain("tm1_list_threads");
    expect(h).toContain("tm1_cancel_thread");
    expect(h).not.toContain("tm1_list_jobs");
  });
});
