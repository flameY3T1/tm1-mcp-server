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
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import type { ProcessResult } from "../../src/types.js";
import { ProcessResultSchema } from "../../src/tools/schemas/items-processes.js";
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
} as unknown as import("pino").Logger;

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
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
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

  it("labels a non-success status as failed, not indeterminate", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        ProcessExecuteStatusCode: "Aborted",
        ErrorLogFile: { Filename: "TM1ProcessError_x.log" },
      }),
    );

    const result = await client.processes.execute("Broken");

    expect(result.success).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.processErrorStatus).toBe("Aborted");
    expect(result.errorLogFile).toBe("TM1ProcessError_x.log");
  });

  it("labels a TM1 error response as failed", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ error: { message: { value: "Prolog aborted" } } }, 400),
    );

    const result = await client.processes.execute("Broken");

    expect(result.outcome).toBe("failed");
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
      outcome: "failed",
      processErrorStatus: "CompletedSuccessfully",
    };
    expect(contradiction.outcome).toBe("failed");
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
      { success: false, outcome: "failed", processErrorStatus: "Aborted" },
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

  it("rejects an unknown outcome value", () => {
    const parsed = ProcessResultSchema.safeParse({
      success: false,
      outcome: "probably-fine",
      processErrorStatus: "?",
    });
    expect(parsed.success).toBe(false);
  });
});
