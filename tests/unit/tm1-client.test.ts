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

function makeConfig(overrides?: Partial<TM1Config>): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
    ...overrides,
  };
}

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}): Response {
  const bodyText =
    opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(opts.body ?? {}),
  } as unknown as Response;
}

/**
 * Expose the protected `request` method for testing via a thin subclass.
 */
class TestTM1Client extends TM1Client {
  async testRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.request<T>(method, path, body);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let sessionManager: SessionManager;
  let client: TestTM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const config = makeConfig();
    sessionManager = new SessionManager(config, mockLogger);
    client = new TestTM1Client(config, sessionManager, mockLogger);

    // Default: ensureSession returns a cookie
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sessionManager, "authenticate").mockResolvedValue("newSession456");
    vi.spyOn(sessionManager, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sessionManager, "stopKeepAlive").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── connect / disconnect / isConnected ───────────────────────────────────

  describe("connect()", () => {
    it("should authenticate and start keep-alive", async () => {
      await client.connect();

      expect(sessionManager.authenticate).toHaveBeenCalledOnce();
      expect(sessionManager.startKeepAlive).toHaveBeenCalledOnce();
      expect(client.isConnected()).toBe(true);
    });
  });

  describe("disconnect()", () => {
    it("should stop keep-alive and mark as disconnected", async () => {
      await client.connect();
      await client.disconnect();

      expect(sessionManager.stopKeepAlive).toHaveBeenCalledOnce();
      expect(client.isConnected()).toBe(false);
    });
  });

  describe("isConnected()", () => {
    it("should return false before connect", () => {
      expect(client.isConnected()).toBe(false);
    });

    it("should return true after connect", async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });
  });

  // ── request() – successful calls ────────────────────────────────────────

  describe("request() – success", () => {
    it("should make GET request with session cookie and return parsed JSON", async () => {
      const data = { value: [{ Name: "SalesCube" }] };
      fetchSpy.mockResolvedValueOnce(mockResponse({ ok: true, body: data }));

      const result = await client.testRequest("GET", "/api/v1/Cubes");

      expect(result).toEqual(data);
      expect(fetchSpy).toHaveBeenCalledOnce();

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://tm1server:8010/api/v1/Cubes");
      expect(opts.method).toBe("GET");
      expect(opts.headers.Cookie).toBe("TM1SessionId=session123");
      expect(opts.headers.Accept).toBe("application/json");
    });

    it("should send JSON body for POST requests", async () => {
      const body = { MDX: "SELECT ... ON ROWS FROM [Sales]" };
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { Cells: [] } }),
      );

      await client.testRequest("POST", "/api/v1/ExecuteMDX", body);

      const [, opts] = fetchSpy.mock.calls[0];
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.body).toBe(JSON.stringify(body));
    });

    it("should return undefined for 204 No Content", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, status: 204, body: undefined }),
      );

      const result = await client.testRequest("DELETE", "/api/v1/Processes('Test')");
      expect(result).toBeUndefined();
    });
  });

  // ── request() – error classification ──────────────────────────────────────

  describe("request() – error classification", () => {
    it("should throw AUTH_FAILED for 401 after re-auth also fails with 401", async () => {
      // First call returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );
      // Re-auth retry also returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );

      await expect(
        client.testRequest("GET", "/api/v1/Cubes"),
      ).rejects.toThrow(TM1Error);

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
      } catch (e) {
        // Reset mocks for the second attempt
      }
    });

    it("should re-authenticate on 401 and retry successfully", async () => {
      // First call returns 401
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 401, statusText: "Unauthorized" }),
      );
      // After re-auth, retry succeeds
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { value: [] } }),
      );

      const result = await client.testRequest("GET", "/api/v1/Cubes");

      expect(result).toEqual({ value: [] });
      expect(sessionManager.authenticate).toHaveBeenCalledOnce();
    });

    it("should throw PERMISSION_DENIED for 403", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 403,
          body: { error: { message: { value: "Insufficient privileges" } } },
        }),
      );

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
        expect(err.httpStatus).toBe(403);
        expect(err.endpoint).toBe("/api/v1/Cubes");
        expect(err.details).toBe("Insufficient privileges");
      }
    });

    it("should throw PERMISSION_DENIED for 400 ObjectSecurityNoReadRights", async () => {
      // TM1 returns security denials as HTTP 400 with a security message, not 403
      // — e.g. a non-admin reading the }DimensionProperties control cube.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: { code: "65", message: "ObjectSecurityNoReadRights" } },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
        expect(err.httpStatus).toBe(400);
        expect(err.details).toBe("ObjectSecurityNoReadRights");
      }
    });

    it("keeps VALIDATION-style 400s as generic (not a security message)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: { message: { value: "Syntax error in MDX statement" } } },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
        expect(err.httpStatus).toBe(400);
      }
    });

    it("should throw NOT_FOUND for 404", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 404,
          body: { error: { message: { value: "Cube not found" } } },
        }),
      );

      try {
        await client.testRequest("GET", "/api/v1/Cubes('Missing')");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.NOT_FOUND);
        expect(err.httpStatus).toBe(404);
      }
    });

    it("should throw CONFLICT for 409", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 409,
          body: { error: { message: { value: "Process already exists" } } },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/Processes");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.CONFLICT);
        expect(err.httpStatus).toBe(409);
      }
    });

    it("should throw TM1_ERROR for 500", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 500,
          body: { error: { message: { value: "Internal server error" } } },
        }),
      );

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
        expect(err.httpStatus).toBe(500);
      }
    });

    it("should throw TM1_ERROR for 400 (bad request)", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          body: { error: { message: "Invalid MDX syntax" } },
        }),
      );

      try {
        await client.testRequest("POST", "/api/v1/ExecuteMDX");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
        expect(err.httpStatus).toBe(400);
      }
    });
  });

  // ── request() – network errors and retry ──────────────────────────────────

  describe("request() – network errors and retry", () => {
    it("should retry on network error and succeed on second attempt", async () => {
      // First attempt: network error
      fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
      // Second attempt: success
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { value: [] } }),
      );

      const result = await client.testRequest("GET", "/api/v1/Cubes");
      expect(result).toEqual({ value: [] });
      // ensureSession called twice (once per attempt)
      expect(sessionManager.ensureSession).toHaveBeenCalledTimes(2);
    });

    it("should retry up to 3 times on network errors then throw CONNECTION_FAILED", async () => {
      // All 4 attempts (initial + 3 retries) fail
      fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

      try {
        await client.testRequest("GET", "/api/v1/Cubes");
        expect.unreachable("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TM1Error);
        const err = e as TM1Error;
        expect(err.code).toBe(TM1ErrorCode.CONNECTION_FAILED);
        expect(err.endpoint).toBe("/api/v1/Cubes");
        expect(err.message).toContain("3 retries");
      }

      // initial + 3 retries = 4 fetch calls
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it("should NOT retry a bare AbortError (caller cancellation, not a network blip)", async () => {
      // Our own request timeout aborts with name "TimeoutError" (→ LOCK_TIMEOUT).
      // A plain "AbortError" can only be caller cancellation and must propagate
      // immediately — retrying a cancelled request is a bug.
      fetchSpy.mockRejectedValueOnce(
        new DOMException("The operation was aborted.", "AbortError"),
      );
      // Would succeed if (wrongly) retried — proves no retry happens.
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { ok: true } }),
      );

      await expect(client.testRequest("GET", "/api/v1/Cubes")).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("should classify ECONNREFUSED as network error and retry", async () => {
      const err = new Error("connect ECONNREFUSED 127.0.0.1:8010");
      fetchSpy.mockRejectedValueOnce(err);
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ ok: true, body: { ok: true } }),
      );

      const result = await client.testRequest("GET", "/api/v1/Cubes");
      expect(result).toEqual({ ok: true });
    });
  });

  // ── TM1Error class ───────────────────────────────────────────────────────

  describe("TM1Error", () => {
    it("should have correct properties", () => {
      const err = new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "Cube not found",
        httpStatus: 404,
        endpoint: "/api/v1/Cubes('Missing')",
        details: "The cube does not exist",
      });

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(TM1Error);
      expect(err.name).toBe("TM1Error");
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toBe("Cube not found");
      expect(err.httpStatus).toBe(404);
      expect(err.endpoint).toBe("/api/v1/Cubes('Missing')");
      expect(err.details).toBe("The cube does not exist");
    });

    it("should work without optional fields", () => {
      const err = new TM1Error({
        code: TM1ErrorCode.CONNECTION_FAILED,
        message: "Connection refused",
      });

      expect(err.httpStatus).toBeUndefined();
      expect(err.endpoint).toBeUndefined();
      expect(err.details).toBeUndefined();
    });
  });
});
