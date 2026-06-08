import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";

const mockLogger = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  level: "silent", flush: vi.fn(),
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
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe("TM1Client – getTransactionLog() preflight probe", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const config = makeConfig();
    const sm = new SessionManager(config, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("session123");
    vi.spyOn(sm, "authenticate").mockResolvedValue("session123");
    vi.spyOn(sm, "startKeepAlive").mockImplementation(() => {});
    vi.spyOn(sm, "stopKeepAlive").mockImplementation(() => {});
    client = new TM1Client(config, sm, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("probes with bare $top=1 (no orderby/filter) then runs the real query", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(
        mockResponse({ value: [{ TimeStamp: "2026-06-01T10:00:00", User: "admin", Cube: "Sales", Tuple: ["a"], OldValue: 1, NewValue: 2 }] }),
      ); // real

    const entries = await client.server.getTransactionLog({ top: 50 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const probeUrl = fetchSpy.mock.calls[0][0] as string;
    expect(probeUrl).toContain("$top=1");
    expect(probeUrl).not.toContain("$orderby");
    expect(probeUrl).not.toContain("$filter");
    const realUrl = fetchSpy.mock.calls[1][0] as string;
    expect(realUrl).toContain("$orderby=TimeStamp desc");
    expect(realUrl).toContain("$top=50");
    expect(entries).toHaveLength(1);
  });

  it("rethrows PERMISSION_DENIED from the probe and skips the heavy query", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ error: { code: "65", message: "ObjectSecurityNoReadRights" } }, 400),
    );

    await expect(client.server.getTransactionLog({})).rejects.toMatchObject({
      code: TM1ErrorCode.PERMISSION_DENIED,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // probe only, real query skipped
  });

  it("maps a non-permission probe failure to an actionable TM1_ERROR", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ error: { message: "Internal error" } }, 500),
    );

    try {
      await client.server.getTransactionLog({});
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as TM1Error;
      expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
      expect(err.message).toContain("Transaction log preflight failed");
      expect(err.hint).toContain("Narrow the query");
    }
  });
});
