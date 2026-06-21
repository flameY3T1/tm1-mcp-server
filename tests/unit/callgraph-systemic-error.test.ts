import { describe, it, expect } from "vitest";
import {
  buildReferenceIndex,
  type ProcessFetchResult,
  type CubeRulesFetchResult,
  type ChoreFetchResult,
} from "../../src/lib/callgraph/referenceIndex.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

const noProcesses = (): Promise<ProcessFetchResult[]> => Promise.resolve([]);
const noCubes = (): Promise<CubeRulesFetchResult[]> => Promise.resolve([]);
const noChores = (): Promise<ChoreFetchResult[]> => Promise.resolve([]);

describe("buildReferenceIndex systemic-error handling (regression)", () => {
  it("propagates a systemic fetch failure instead of building an empty index", async () => {
    // An auth/connection/lock failure must NOT degrade to an empty index —
    // otherwise an outage looks like an empty server and gets cached as truth.
    const authFail = (): Promise<ProcessFetchResult[]> =>
      Promise.reject(
        new TM1Error({ code: TM1ErrorCode.AUTH_FAILED, message: "session expired" })
      );

    await expect(
      buildReferenceIndex({
        fetchProcesses: authFail,
        fetchCubesWithRules: noCubes,
        fetchChores: noChores,
      })
    ).rejects.toThrow(TM1Error);
  });

  it("degrades a non-systemic (NOT_FOUND) fetch failure to an empty slice", async () => {
    // Per-source tolerance: a missing/forbidden domain still yields a usable
    // (partial) index rather than failing the whole build.
    const notFound = (): Promise<CubeRulesFetchResult[]> =>
      Promise.reject(
        new TM1Error({ code: TM1ErrorCode.NOT_FOUND, message: "no cubes" })
      );

    const index = await buildReferenceIndex({
      fetchProcesses: noProcesses,
      fetchCubesWithRules: notFound,
      fetchChores: noChores,
    });

    expect(index).toBeDefined();
  });
});
