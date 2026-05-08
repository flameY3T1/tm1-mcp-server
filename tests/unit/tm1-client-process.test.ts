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

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.execute("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
    });
  });

  // ── getProcessParameters() ───────────────────────────────────────────────

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
});
