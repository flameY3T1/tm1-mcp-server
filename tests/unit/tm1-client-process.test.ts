import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  const bodyText = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function mock204Response(): Response {
  return {
    ok: true,
    status: 204,
    statusText: "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – Process Execution Methods", () => {
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

  // ── executeProcess() ─────────────────────────────────────────────────────

  describe("executeProcess()", () => {
    it("should return success when process completes with 204", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      const result = await client.processes.execute("ImportData");

      expect(result).toEqual({
        success: true,
        processErrorStatus: "CompletedSuccessfully",
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')/tm1.Execute");
      expect(opts.method).toBe("POST");
    });

    it("should return success when process completes with 200 empty body", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue(""),
      } as unknown as Response);

      const result = await client.processes.execute("RunCalc");

      expect(result.success).toBe(true);
      expect(result.processErrorStatus).toBe("CompletedSuccessfully");
    });

    it("should send parameters in the request body", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("ImportData", {
        pFilePath: "/data/input.csv",
        pYear: 2024,
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([
        { Name: "pFilePath", Value: "/data/input.csv" },
        { Name: "pYear", Value: 2024 },
      ]);
    });

    it("should send empty body when no parameters provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("SimpleProcess");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toBeUndefined();
    });

    it("should send empty body when params is an empty object", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("SimpleProcess", {});

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toBeUndefined();
    });

    it("should return failure when TM1 returns an error", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process aborted with error in Prolog" } } },
          400,
        ),
      );

      const result = await client.processes.execute("BrokenProcess");

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toContain("Process aborted with error in Prolog");
    });

    it("should return failure when process is not found (404)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process 'NonExistent' not found" } } },
          404,
        ),
      );

      const result = await client.processes.execute("NonExistent");

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toContain("not found");
    });

    it("propagates a systemic transport failure instead of reporting success:false (M1)", async () => {
      // A network drop maps to CONNECTION_FAILED. Unlike a TI runtime error, this
      // must throw: the process may still be running server-side, so a
      // {success:false} would invite the agent to re-run it (duplicate execution).
      fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.1:8010"));

      await expect(client.processes.execute("LongRunningLoad")).rejects.toThrow();
    });

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
    });
  });

  // ── getProcessParameters() ───────────────────────────────────────────────

  describe("exists()", () => {
    it("returns true on 200 and probes with $select=Name (not a full list)", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ Name: "ImportData" }));
      expect(await client.processes.exists("ImportData")).toBe(true);
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')?$select=Name");
    });

    it("returns false when the process is not found (404)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { message: "not found" } }, 404),
      );
      expect(await client.processes.exists("Nope")).toBe(false);
    });

    it("rethrows a non-NOT_FOUND error instead of reporting absent", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { message: "forbidden" } }, 403),
      );
      await expect(client.processes.exists("Secret")).rejects.toThrow();
    });
  });

  describe("getProcessParameters()", () => {
    it("should return parameters with correct type mapping", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "pFilePath", Type: "String", Value: "/data/input.csv", Prompt: "Enter file path" },
            { Name: "pYear", Type: "Numeric", Value: 2024 },
          ],
        }),
      );

      const params = await client.processes.getParameters("ImportData");

      expect(params).toEqual([
        { name: "pFilePath", type: "String", defaultValue: "/data/input.csv", prompt: "Enter file path" },
        { name: "pYear", type: "Numeric", defaultValue: 2024 },
      ]);

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportData')/Parameters");
    });

    it("should return empty array when process has no parameters", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      const params = await client.processes.getParameters("NoParamProcess");
      expect(params).toEqual([]);
    });

    it("should map Type 'Numeric' / 'String' from TM1 v11 API", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "numParam", Type: "Numeric", Value: 0 },
            { Name: "strParam", Type: "String", Value: "" },
          ],
        }),
      );

      const params = await client.processes.getParameters("TestProc");
      expect(params[0].type).toBe("Numeric");
      expect(params[1].type).toBe("String");
    });

    it("should omit prompt when not present in API response", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          value: [
            { Name: "pParam", Type: "String", Value: "default" },
          ],
        }),
      );

      const params = await client.processes.getParameters("TestProc");
      expect(params[0]).not.toHaveProperty("prompt");
    });

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

      await client.processes.getParameters("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
    });
  });

  // ── saveData() ────────────────────────────────────────────────────────────

  describe("saveData()", () => {
    it("should run SaveDataAll as unbound process when no cube is given", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ProcessExecuteStatusCode: "CompletedSuccessfully" }),
      );

      const result = await client.processes.saveData();

      expect(result).toEqual({
        success: true,
        processErrorStatus: "CompletedSuccessfully",
        errorLogFile: undefined,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/ExecuteProcessWithReturn");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.Process.PrologProcedure).toBe("SaveDataAll;");
      expect(body.Process.DataSource).toEqual({ Type: "None" });
    });

    it("should run CubeSaveData for a single cube and escape quotes", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ProcessExecuteStatusCode: "CompletedSuccessfully" }),
      );

      await client.processes.saveData("Bob's Cube");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Process.PrologProcedure).toBe("CubeSaveData('Bob''s Cube');");
    });

    it("should report failure status and error log file", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ProcessExecuteStatusCode: "CompletedWithMessages",
          ErrorLogFile: { Filename: "TM1ProcessError_x.log" },
        }),
      );

      const result = await client.processes.saveData();

      expect(result.success).toBe(false);
      expect(result.processErrorStatus).toBe("CompletedWithMessages");
      expect(result.errorLogFile).toBe("TM1ProcessError_x.log");
    });
  });

  // Regression: TM1 v11 ignores the parameter `Type` field and classifies a
  // parameter from the JSON type of `Value`. Encoding must coerce `Value` to
  // the declared `type` (and emit the correct OData enum: String=1, Numeric=2),
  // otherwise a Numeric param whose default arrives as a string is stored as
  // String. Verified against a live PATCH+read roundtrip.
  describe("updateParameters() – parameter encoding", () => {
    it("encodes Numeric as Type 2 and coerces a string default to a number", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: "0" },
      ]);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('Proc')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0]).toEqual({ Name: "pNum", Type: 2, Value: 0 });
      expect(typeof body.Parameters[0].Value).toBe("number");
    });

    it("encodes String as Type 1 and coerces a number default to a string", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pStr", type: "String", defaultValue: 0 },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0]).toEqual({ Name: "pStr", Type: 1, Value: "0" });
      expect(typeof body.Parameters[0].Value).toBe("string");
    });

    it("falls back to 0 for a Numeric default that is not a finite number", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: "abc" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0].Value).toBe(0);
    });

    it("includes Prompt only when present", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("Proc", [
        { name: "pNum", type: "Numeric", defaultValue: 1, prompt: "Year" },
        { name: "pStr", type: "String", defaultValue: "" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0].Prompt).toBe("Year");
      expect(body.Parameters[1]).not.toHaveProperty("Prompt");
    });
  });
});
