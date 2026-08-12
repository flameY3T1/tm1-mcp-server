// T-4 — execution results that cannot express failure.
//
// Two defects, one type:
//   1. `?? "CompletedSuccessfully"` made a MISSING ProcessExecuteStatusCode
//      mean "the process ran fine". A server that answers without the field —
//      or with an empty body — was reported to the model as a successful run.
//      The honest reading is that the outcome is UNKNOWN.
//   2. `{success: true, processErrorStatus: "Aborted"}` was a representable
//      value. Nothing in the type stopped a future edit from producing it.
//
// `ProcessResult` is now a discriminated union: `success` is a literal per
// variant, `outcome` names the third state, and the success variant pins
// `processErrorStatus` to the one status that can accompany it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import type { ProcessResult } from "../../src/types.js";
import { ProcessResultSchema } from "../../src/tools/schemas/items-processes.js";
import { classifyExecution } from "../../src/tm1-client/services/process-status.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

function makeConfig(): TM1Config {
  return {
    ...baseTestConfig,
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
  };
}

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function mockEmptyBody(status = 200): Response {
  return {
    ok: true,
    status,
    statusText: status === 200 ? "OK" : "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

describe("ProcessResult — a missing status code is not success (T-4)", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
    const config = makeConfig();
    const sessionManager = new SessionManager(config, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports an execution with no ProcessExecuteStatusCode as indeterminate", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ErrorLogFile: null }));

    const result = await client.processes.execute("ImportData");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("indeterminate");
    // The status text has to say so — it is the only channel the tool has for
    // telling the model "we do not know whether this ran".
    expect(result.processErrorStatus).toMatch(/ProcessExecuteStatusCode/);
  });

  it("reports an empty response body as indeterminate, not as a successful run", async () => {
    fetchSpy.mockResolvedValueOnce(mockEmptyBody(200));

    const result = await client.processes.execute("RunCalc");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("indeterminate");
  });

  it("reports a 204 No Content as indeterminate", async () => {
    fetchSpy.mockResolvedValueOnce(mockEmptyBody(204));

    const result = await client.processes.execute("RunCalc");

    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
  });

  it("applies the same rule to saveData", async () => {
    fetchSpy.mockResolvedValueOnce(mockEmptyBody(204));

    const result = await client.processes.saveData();

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("indeterminate");
  });

  it("still reports a real CompletedSuccessfully as succeeded", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        ProcessExecuteStatusCode: "CompletedSuccessfully",
        ErrorLogFile: null,
      }),
    );

    const result = await client.processes.execute("ImportData");

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("succeeded");
    expect(result.processErrorStatus).toBe("CompletedSuccessfully");
  });

  it("labels an aborted run rolled_back, not indeterminate", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        ProcessExecuteStatusCode: "Aborted",
        ErrorLogFile: { Filename: "TM1ProcessError_x.log" },
      }),
    );

    const result = await client.processes.execute("Broken");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("rolled_back");
    expect(result.processErrorStatus).toBe("Aborted");
    expect(result.errorLogFile).toBe("TM1ProcessError_x.log");
  });

  it("labels a TM1 error response indeterminate and keeps the server text", async () => {
    // The call errored, so TM1 never reported a status — and an error raised
    // mid-run tells us nothing about whether the run committed. Claiming a
    // rollback we did not observe would be the same fail-open mistake in a
    // different direction.
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ error: { message: "Prolog aborted" } }, 400),
    );

    const result = await client.processes.execute("Broken");

    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
    expect(result.processErrorStatus).toContain("Prolog aborted");
  });
});

// One case per member of tm1.ProcessExecuteStatusCode. The enum has exactly
// six (read from the $metadata of both an 11.8 and a 12.5.9 server — identical,
// no version drift), and the grouping below is the live-measured commit
// behaviour, not a reading of the names: a marker cell written in the Prolog
// survived ItemReject and ProcessQuit, and was gone after ProcessError and
// ProcessRollback. HasMinorErrors too: its documented path is per-record
// failures in the Metadata/Data tabs (which need a data source), but a Prolog
// write to a consolidated element produces the same code without one — and the
// marker survived, so it belongs with the committed group.
describe("classifyExecution — one row per ProcessExecuteStatusCode", () => {
  const CASES: ReadonlyArray<{
    status: string;
    outcome: ProcessResult["outcome"];
    success: boolean;
  }> = [
    { status: "CompletedSuccessfully", outcome: "succeeded", success: true },
    {
      status: "HasMinorErrors",
      outcome: "completed_with_errors",
      success: false,
    },
    { status: "QuitCalled", outcome: "completed_with_errors", success: false },
    {
      status: "CompletedWithMessages",
      outcome: "completed_with_errors",
      success: false,
    },
    { status: "Aborted", outcome: "rolled_back", success: false },
    { status: "RollbackCalled", outcome: "rolled_back", success: false },
  ];

  for (const c of CASES) {
    it(`maps ${c.status} to ${c.outcome} (success=${String(c.success)})`, () => {
      const result = classifyExecution(c.status, undefined);
      expect(result.outcome).toBe(c.outcome);
      expect(result.success).toBe(c.success);
      expect(result.processErrorStatus).toBe(c.status);
    });
  }

  it("carries the error log file through unchanged", () => {
    const result = classifyExecution("Aborted", "TM1ProcessError_y.log");
    expect(result.errorLogFile).toBe("TM1ProcessError_y.log");
  });

  it("maps a status code this build does not know to indeterminate", () => {
    // A seventh member added by a future TM1 must not be absorbed into a group
    // whose commit semantics we never measured — that is how the old
    // everything-else-is-failed branch would have swallowed it.
    const result = classifyExecution("SomeFutureStatus", undefined);
    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
    expect(result.processErrorStatus).toContain("SomeFutureStatus");
    expect(result.processErrorStatus).toMatch(/unrecognised/i);
  });

  it("maps a missing status code to indeterminate (T-4)", () => {
    const result = classifyExecution(undefined, undefined);
    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
    expect(result.processErrorStatus).toMatch(/ProcessExecuteStatusCode/);
  });

  it("maps an empty status code to indeterminate", () => {
    const result = classifyExecution("", undefined);
    expect(result.outcome).toBe("indeterminate");
    expect(result.success).toBe(false);
  });
});

describe("ProcessResult — contradictory states are unrepresentable (T-4)", () => {
  it("rejects {success: true} paired with a failure status at compile time", () => {
    // @ts-expect-error success:true can only carry "CompletedSuccessfully"
    const contradiction: ProcessResult = {
      success: true,
      outcome: "succeeded",
      processErrorStatus: "Aborted",
    };
    expect(contradiction.processErrorStatus).toBe("Aborted");
  });

  it("rejects {success: true} paired with a non-success outcome at compile time", () => {
    // @ts-expect-error outcome and success are the same axis; they cannot disagree
    const contradiction: ProcessResult = {
      success: true,
      outcome: "rolled_back",
      processErrorStatus: "CompletedSuccessfully",
    };
    expect(contradiction.outcome).toBe("rolled_back");
  });

  it("rejects an indeterminate result that claims success at compile time", () => {
    // @ts-expect-error "we don't know" is never success
    const contradiction: ProcessResult = {
      success: true,
      outcome: "indeterminate",
      processErrorStatus: "Unknown",
    };
    expect(contradiction.outcome).toBe("indeterminate");
  });

  it("narrows on `success` without a cast", () => {
    const results: ProcessResult[] = [
      {
        success: true,
        outcome: "succeeded",
        processErrorStatus: "CompletedSuccessfully",
      },
      { success: false, outcome: "rolled_back", processErrorStatus: "Aborted" },
    ];
    const statuses = results.map((r) =>
      r.success ? r.processErrorStatus : `!${r.processErrorStatus}`,
    );
    expect(statuses).toEqual(["CompletedSuccessfully", "!Aborted"]);
  });
});

describe("ProcessResultSchema carries the new field (strict output gate)", () => {
  it("accepts the indeterminate payload the handler now returns", () => {
    const parsed = ProcessResultSchema.safeParse({
      success: false,
      outcome: "indeterminate",
      processErrorStatus: "Unknown: TM1 returned no ProcessExecuteStatusCode",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a successful payload", () => {
    const parsed = ProcessResultSchema.safeParse({
      success: true,
      outcome: "succeeded",
      processErrorStatus: "CompletedSuccessfully",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts the two committed/rolled-back payloads", () => {
    for (const outcome of ["completed_with_errors", "rolled_back"]) {
      const parsed = ProcessResultSchema.safeParse({
        success: false,
        outcome,
        processErrorStatus: "QuitCalled",
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects an unknown outcome value", () => {
    const parsed = ProcessResultSchema.safeParse({
      success: false,
      outcome: "probably-fine",
      processErrorStatus: "?",
    });
    expect(parsed.success).toBe(false);
  });
});
