import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

// Silence logger in tests
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
    requestTimeoutMs: 30000,
    logLevel: "info",
    ...overrides,
  };
}

function mockFetchResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  setCookie?: string | null;
}) {
  const headers = new Headers();
  if (opts.setCookie) {
    headers.set("set-cookie", opts.setCookie);
  }
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response;
}

describe("SessionManager", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("authenticate()", () => {
    it("should GET ProductVersion with Basic Auth and return session cookie", async () => {
      const sessionId = "abc123sessiontoken";
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          status: 200,
          setCookie: `TM1SessionId=${sessionId}; Path=/; HttpOnly`,
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      const cookie = await sm.authenticate();

      expect(cookie).toBe(sessionId);
      expect(fetchSpy).toHaveBeenCalledOnce();

      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://tm1server:8010/api/v1/Configuration/ProductVersion");
      expect(opts.method).toBe("GET");

      const expectedAuth = `Basic ${Buffer.from("admin:secret").toString("base64")}`;
      expect(opts.headers.Authorization).toBe(expectedAuth);
    });

    it("should mark session as active after successful auth", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      expect(sm.isSessionActive()).toBe(false);

      await sm.authenticate();
      expect(sm.isSessionActive()).toBe(true);
    });

    it("should throw when authentication returns non-OK status", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await expect(sm.authenticate()).rejects.toThrow(
        "Authentication failed with status 401: Unauthorized"
      );
      expect(sm.isSessionActive()).toBe(false);
    });

    it("should throw when no TM1SessionId cookie in response", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ ok: true, setCookie: null })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await expect(sm.authenticate()).rejects.toThrow(
        "no TM1SessionId cookie found"
      );
    });

    it("should throw on timeout", async () => {
      fetchSpy.mockImplementationOnce(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => {
              const err = new DOMException("The operation was aborted.", "AbortError");
              reject(err);
            });
          })
      );

      const sm = new SessionManager(
        makeConfig({ requestTimeoutMs: 50 }),
        mockLogger
      );
      await expect(sm.authenticate()).rejects.toThrow("timed out");
    });

    it("should encode special characters in credentials correctly", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=tok; Path=/",
        })
      );

      const sm = new SessionManager(
        makeConfig({ user: "user@domain", password: "p@ss:word!" }),
        mockLogger
      );
      await sm.authenticate();

      const [, opts] = fetchSpy.mock.calls[0];
      const expected = `Basic ${Buffer.from("user@domain:p@ss:word!").toString("base64")}`;
      expect(opts.headers.Authorization).toBe(expected);
    });
  });

  describe("keepAlive()", () => {
    it("should GET /api/v1/ActiveSession with session cookie", async () => {
      // First authenticate
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );
      // Then keep-alive
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ ok: true, status: 200 })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.authenticate();
      await sm.keepAlive();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [url, opts] = fetchSpy.mock.calls[1];
      expect(url).toBe("https://tm1server:8010/api/v1/ActiveSession");
      expect(opts.method).toBe("GET");
      expect(opts.headers.Cookie).toBe("TM1SessionId=sess1");
    });

    it("should re-authenticate when keep-alive returns 401", async () => {
      // Initial auth
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=old; Path=/",
        })
      );
      // Keep-alive returns 401
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ ok: false, status: 401, statusText: "Unauthorized" })
      );
      // Re-auth
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=new; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.authenticate();
      await sm.keepAlive();

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(sm.isSessionActive()).toBe(true);
    });

    it("should authenticate if no session exists when keepAlive is called", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=fresh; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.keepAlive();

      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(sm.isSessionActive()).toBe(true);
    });

    it("should throw on non-401 error status", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({ ok: false, status: 500, statusText: "Internal Server Error" })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.authenticate();
      await expect(sm.keepAlive()).rejects.toThrow("Keep-alive failed with status 500");
    });
  });

  describe("ensureSession()", () => {
    it("should return existing session cookie without re-authenticating", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=existing; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.authenticate();

      const cookie = await sm.ensureSession();
      expect(cookie).toBe("existing");
      // Only the initial auth call
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it("should authenticate if no session exists", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=new; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      const cookie = await sm.ensureSession();

      expect(cookie).toBe("new");
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  describe("startKeepAlive() / stopKeepAlive()", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should call keepAlive at the configured interval", async () => {
      // Auth
      fetchSpy.mockResolvedValue(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );

      const sm = new SessionManager(
        makeConfig({ keepAliveIntervalMs: 1000 }),
        mockLogger
      );
      await sm.authenticate();

      sm.startKeepAlive();

      // Advance time by one interval
      await vi.advanceTimersByTimeAsync(1000);
      // Auth call + 1 keep-alive
      expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      sm.stopKeepAlive();
    });

    it("should stop keep-alive when stopKeepAlive is called", async () => {
      fetchSpy.mockResolvedValue(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );

      const sm = new SessionManager(
        makeConfig({ keepAliveIntervalMs: 1000 }),
        mockLogger
      );
      await sm.authenticate();

      sm.startKeepAlive();
      sm.stopKeepAlive();

      const callsBefore = fetchSpy.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      // No additional calls after stop
      expect(fetchSpy.mock.calls.length).toBe(callsBefore);
    });

    it("should not start duplicate timers", async () => {
      fetchSpy.mockResolvedValue(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );

      const sm = new SessionManager(
        makeConfig({ keepAliveIntervalMs: 1000 }),
        mockLogger
      );
      await sm.authenticate();

      sm.startKeepAlive();
      sm.startKeepAlive(); // second call should be no-op

      await vi.advanceTimersByTimeAsync(1000);
      // Should only have auth + 1 keep-alive, not 2
      expect(fetchSpy.mock.calls.length).toBe(2);

      sm.stopKeepAlive();
    });
  });

  describe("isSessionActive()", () => {
    it("should return false before authentication", () => {
      const sm = new SessionManager(makeConfig(), mockLogger);
      expect(sm.isSessionActive()).toBe(false);
    });

    it("should return true after successful authentication", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          ok: true,
          setCookie: "TM1SessionId=sess1; Path=/",
        })
      );

      const sm = new SessionManager(makeConfig(), mockLogger);
      await sm.authenticate();
      expect(sm.isSessionActive()).toBe(true);
    });
  });
});
