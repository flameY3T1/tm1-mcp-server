import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
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

function mock201Response(body?: unknown): Response {
  const bodyText = body ? JSON.stringify(body) : "";
  return {
    ok: true,
    status: 201,
    statusText: "Created",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body ?? {}),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – TI Development Methods", () => {
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

  // ── createProcess() ──────────────────────────────────────────────────────

  describe("createProcess()", () => {
    it("should POST to /api/v1/Processes with the process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock201Response({ Name: "NewProcess" }));

      await client.processes.create("NewProcess");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ Name: "NewProcess" });
    });

    it("should throw CONFLICT error when process already exists (409)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process 'Existing' already exists" } } },
          409,
        ),
      );

      await expect(client.processes.create("Existing")).rejects.toThrow(TM1Error);
      try {
        await client.processes.create("Existing");
      } catch (e) {
        // The first call already threw; we verify the error from the first call
      }
      // Re-test with fresh mock
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process 'Existing' already exists" } } },
          409,
        ),
      );
      try {
        await client.processes.create("Existing");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        expect((e as TM1Error).code).toBe(TM1ErrorCode.CONFLICT);
        expect((e as TM1Error).httpStatus).toBe(409);
      }
    });

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock201Response());

      await client.processes.create("My New Process");

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Name).toBe("My New Process");
    });
  });

  // ── getProcessCode() ─────────────────────────────────────────────────────

  describe("getProcessCode()", () => {
    it("should return all four code tabs from the process", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "TestProcess",
          PrologProcedure: "# Prolog\nASCIIOutput('log.txt', 'start');",
          MetadataProcedure: "# Metadata",
          DataProcedure: "# Data\nCellPutN(1, 'Cube', 'e1', 'e2');",
          EpilogProcedure: "# Epilog\nASCIIOutput('log.txt', 'done');",
        }),
      );

      const code = await client.processes.getCode("TestProcess");

      expect(code).toEqual({
        prolog: "# Prolog\nASCIIOutput('log.txt', 'start');",
        metadata: "# Metadata",
        data: "# Data\nCellPutN(1, 'Cube', 'e1', 'e2');",
        epilog: "# Epilog\nASCIIOutput('log.txt', 'done');",
      });

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
    });

    it("should return empty strings for empty code tabs", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "EmptyProcess",
          PrologProcedure: "",
          MetadataProcedure: "",
          DataProcedure: "",
          EpilogProcedure: "",
        }),
      );

      const code = await client.processes.getCode("EmptyProcess");

      expect(code.prolog).toBe("");
      expect(code.metadata).toBe("");
      expect(code.data).toBe("");
      expect(code.epilog).toBe("");
    });

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          PrologProcedure: "",
          MetadataProcedure: "",
          DataProcedure: "",
          EpilogProcedure: "",
        }),
      );

      await client.processes.getCode("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
    });
  });

  // ── updateProcessCode() ──────────────────────────────────────────────────

  describe("updateProcessCode()", () => {
    it("should PATCH only the specified tabs", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", {
        prolog: "# New Prolog",
        data: "# New Data",
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        PrologProcedure: "# New Prolog",
        DataProcedure: "# New Data",
      });
      expect(body.MetadataProcedure).toBeUndefined();
      expect(body.EpilogProcedure).toBeUndefined();
    });

    it("should PATCH all four tabs when all are provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", {
        prolog: "p",
        metadata: "m",
        data: "d",
        epilog: "e",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        PrologProcedure: "p",
        MetadataProcedure: "m",
        DataProcedure: "d",
        EpilogProcedure: "e",
      });
    });

    it("should PATCH a single tab", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateCode("TestProcess", { epilog: "# Epilog only" });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ EpilogProcedure: "# Epilog only" });
    });
  });

  // ── getProcessDataSource() ───────────────────────────────────────────────

  describe("getProcessDataSource()", () => {
    it("should return data source with type None", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "TestProcess",
          DataSource: { Type: "None" },
        }),
      );

      const ds = await client.processes.getDataSource("TestProcess");

      expect(ds).toEqual({ type: "None" });
    });

    it("should return ASCII data source with all fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "ImportCSV",
          DataSource: {
            Type: "ASCII",
            dataSourceNameForServer: "/data/input.csv",
            dataSourceNameForClient: "C:\\data\\input.csv",
            asciiDelimiterChar: ",",
            asciiQuoteCharacter: "\"",
            asciiHeaderRecords: 1,
          },
        }),
      );

      const ds = await client.processes.getDataSource("ImportCSV");

      expect(ds).toEqual({
        type: "ASCII",
        dataSourceNameForServer: "/data/input.csv",
        dataSourceNameForClient: "C:\\data\\input.csv",
        asciiDelimiterChar: ",",
        asciiQuoteCharacter: "\"",
        asciiHeaderRecords: 1,
      });
    });

    it("should return ODBC data source", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "ODBCProcess",
          DataSource: {
            Type: "ODBC",
            oDBCConnection: "DSN=MyDB",
            query: "SELECT * FROM table1",
          },
        }),
      );

      const ds = await client.processes.getDataSource("ODBCProcess");

      expect(ds.type).toBe("ODBC");
      expect(ds.oDBCConnection).toBe("DSN=MyDB");
      expect(ds.query).toBe("SELECT * FROM table1");
    });

    it("should omit undefined optional fields", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          Name: "SimpleProcess",
          DataSource: { Type: "None" },
        }),
      );

      const ds = await client.processes.getDataSource("SimpleProcess");

      expect(ds).toEqual({ type: "None" });
      expect(ds).not.toHaveProperty("dataSourceNameForServer");
      expect(ds).not.toHaveProperty("oDBCConnection");
    });
  });

  // ── updateProcessDataSource() ────────────────────────────────────────────

  describe("updateProcessDataSource()", () => {
    it("should PATCH with DataSource object for ASCII type", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("ImportCSV", {
        type: "ASCII",
        dataSourceNameForServer: "/data/new.csv",
        asciiDelimiterChar: ";",
        asciiHeaderRecords: 2,
      });

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('ImportCSV')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.DataSource).toEqual({
        Type: "ASCII",
        dataSourceNameForServer: "/data/new.csv",
        asciiDelimiterChar: ";",
        asciiHeaderRecords: 2,
      });
    });

    it("should PATCH with DataSource type None", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("TestProcess", { type: "None" });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource).toEqual({ Type: "None" });
    });

    it("should PATCH with ODBC data source", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateDataSource("ODBCProcess", {
        type: "ODBC",
        oDBCConnection: "DSN=NewDB",
        query: "SELECT id FROM users",
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource.Type).toBe("ODBC");
      expect(body.DataSource.oDBCConnection).toBe("DSN=NewDB");
      expect(body.DataSource.query).toBe("SELECT id FROM users");
    });

    it("should drop usesUnicode on TM1 11.x", async () => {
      const cfg = { ...makeConfig(), tm1Version: "11.8" } as TM1Config;
      const sm = new SessionManager(cfg, mockLogger);
      vi.spyOn(sm, "ensureSession").mockResolvedValue("sess");
      vi.spyOn(sm, "authenticate").mockResolvedValue("sess");
      const c = new TM1Client(cfg, sm, mockLogger);
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await c.processes.updateDataSource("ImportCSV", {
        type: "ASCII",
        dataSourceNameForServer: "/data/x.csv",
        usesUnicode: true,
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource).not.toHaveProperty("usesUnicode");
    });

    it("should send usesUnicode on TM1 12.x", async () => {
      const cfg = { ...makeConfig(), tm1Version: "12.0" } as TM1Config;
      const sm = new SessionManager(cfg, mockLogger);
      vi.spyOn(sm, "ensureSession").mockResolvedValue("sess");
      vi.spyOn(sm, "authenticate").mockResolvedValue("sess");
      const c = new TM1Client(cfg, sm, mockLogger);
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await c.processes.updateDataSource("ImportCSV", {
        type: "ASCII",
        dataSourceNameForServer: "/data/x.csv",
        usesUnicode: true,
      });

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.DataSource.usesUnicode).toBe(true);
    });
  });

  // ── updateProcessParameters() ────────────────────────────────────────────

  describe("updateProcessParameters()", () => {
    it("should PATCH with Parameters array", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", [
        { name: "pFile", type: "String", defaultValue: "/data/in.csv", prompt: "File path" },
        { name: "pYear", type: "Numeric", defaultValue: 2024 },
      ]);

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('TestProcess')");
      expect(opts.method).toBe("PATCH");
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([
        { Name: "pFile", Type: 2, Value: "/data/in.csv", Prompt: "File path" },
        { Name: "pYear", Type: 1, Value: 2024 },
      ]);
    });

    it("should map Numeric type to 1 and String type to 2", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", [
        { name: "num", type: "Numeric", defaultValue: 0 },
        { name: "str", type: "String", defaultValue: "" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0].Type).toBe(1);
      expect(body.Parameters[1].Type).toBe(2);
    });

    it("should send empty Parameters array when no params provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", []);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters).toEqual([]);
    });

    it("should omit Prompt when not provided", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.updateParameters("TestProcess", [
        { name: "p1", type: "String", defaultValue: "val" },
      ]);

      const [, opts] = fetchSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.Parameters[0]).not.toHaveProperty("Prompt");
    });
  });

  // ── deleteProcess() ──────────────────────────────────────────────────────

  describe("deleteProcess()", () => {
    it("should DELETE the process by name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.delete("OldProcess");

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/Processes('OldProcess')");
      expect(opts.method).toBe("DELETE");
    });

    it("should throw NOT_FOUND when process does not exist", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process 'Ghost' not found" } } },
          404,
        ),
      );

      await expect(client.processes.delete("Ghost")).rejects.toThrow(TM1Error);
      fetchSpy.mockResolvedValueOnce(
        mockResponse(
          { error: { message: { value: "Process 'Ghost' not found" } } },
          404,
        ),
      );
      try {
        await client.processes.delete("Ghost");
      } catch (e) {
        expect((e as TM1Error).code).toBe(TM1ErrorCode.NOT_FOUND);
        expect((e as TM1Error).httpStatus).toBe(404);
      }
    });

    it("should encode special characters in process name", async () => {
      fetchSpy.mockResolvedValueOnce(mock204Response());

      await client.processes.delete("My Process");

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("Processes('My%20Process')");
    });
  });
});
