import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import { toOdataDateTime } from "../../src/tm1-client/services/server-service.js";
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

const ENTRY = (cube: string) => ({
  TimeStamp: "2026-06-08T10:00:00Z", User: "admin", Cube: cube, Tuple: ["x"], OldValue: 1, NewValue: 2,
});

describe("toOdataDateTime", () => {
  it("appends Z to a zoneless datetime (TM1 rejects bare datetimes)", () => {
    expect(toOdataDateTime("2026-06-08T00:00:00")).toBe("2026-06-08T00:00:00Z");
  });
  it("expands a date-only value to start-of-day UTC", () => {
    expect(toOdataDateTime("2026-06-08")).toBe("2026-06-08T00:00:00Z");
  });
  it("leaves an already-zoned value untouched", () => {
    expect(toOdataDateTime("2026-06-08T00:00:00Z")).toBe("2026-06-08T00:00:00Z");
    expect(toOdataDateTime("2026-06-08T00:00:00+02:00")).toBe("2026-06-08T00:00:00+02:00");
  });
});

describe("TM1Client – getTransactionLog()", () => {
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

  it("preflight-probes with a bare $top=1 (no orderby/filter)", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("Sales")] })); // window 1

    await client.server.getTransactionLog({ top: 1 });

    const probeUrl = fetchSpy.mock.calls[0][0] as string;
    expect(probeUrl).toContain("$top=1");
    expect(probeUrl).not.toContain("$orderby");
    expect(probeUrl).not.toContain("$filter");
  });

  it("no `since`: queries an expanding window and stops once top rows are found", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A"), ENTRY("B")] })); // window 1 has >= top

    const { entries } = await client.server.getTransactionLog({ top: 2 });

    expect(entries).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // probe + 1 window only
    const w1 = decodeURIComponent(fetchSpy.mock.calls[1][0] as string);
    expect(w1).toContain("$orderby=TimeStamp desc");
    expect(w1).toContain("TimeStamp ge "); // a window lower bound was applied
    expect(w1).toContain("Z"); // UTC literal
  });

  it("no `since`: widens the window when the first is short", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A")] })) // window 1 short (<top)
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A"), ENTRY("B")] })); // window 2 enough

    const { entries } = await client.server.getTransactionLog({ top: 2 });

    expect(entries).toHaveLength(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // probe + 2 windows
  });

  it("no `since`: hitting `top` marks coverage partial with an earliest-scanned floor", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A"), ENTRY("B")] })); // window 1 >= top

    const res = await client.server.getTransactionLog({ top: 2 });

    expect(res.entries).toHaveLength(2);
    expect(res.coverage).toBe("partial");
    expect(res.scannedFrom).toMatch(/Z$/); // floor of the scanned window, UTC literal
  });

  it("no `since`: exhausting windows marks coverage complete", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValue(mockResponse({ value: [ENTRY("A")] })); // every window short (<top)

    const res = await client.server.getTransactionLog({ top: 5 });

    expect(res.entries).toHaveLength(1);
    expect(res.coverage).toBe("complete");
    expect(res.scannedFrom).toMatch(/Z$/);
  });

  it("explicit `since`: coverage is complete within the bound", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A")] })); // single query

    const res = await client.server.getTransactionLog({ since: "2026-06-01", top: 10 });

    expect(res.coverage).toBe("complete");
    expect(res.scannedFrom).toContain("2026-06-01");
  });

  it("explicit `since` runs a single bounded query (no windowing) with a Z literal", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [ENTRY("A")] })); // single query

    await client.server.getTransactionLog({ since: "2026-06-08T00:00:00", top: 100 });

    expect(fetchSpy).toHaveBeenCalledTimes(2); // probe + one query, no widening
    const url = decodeURIComponent(fetchSpy.mock.calls[1][0] as string);
    expect(url).toContain("TimeStamp ge 2026-06-08T00:00:00Z");
  });

  it("since + until produces a from-to range filter", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe
      .mockResolvedValueOnce(mockResponse({ value: [] })); // single query

    await client.server.getTransactionLog({ since: "2026-06-01", until: "2026-06-08", top: 10 });

    const url = decodeURIComponent(fetchSpy.mock.calls[1][0] as string);
    expect(url).toContain("TimeStamp ge 2026-06-01T00:00:00Z");
    expect(url).toContain("TimeStamp le 2026-06-08T00:00:00Z");
  });

  it("rethrows PERMISSION_DENIED from the probe and skips the query", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ error: { code: "65", message: "ObjectSecurityNoReadRights" } }, 400),
    );

    await expect(client.server.getTransactionLog({})).rejects.toMatchObject({
      code: TM1ErrorCode.PERMISSION_DENIED,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("explicit `since` surfaces an actionable error when the query fails", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe ok
      .mockResolvedValue(mockResponse({ error: { message: "boom" } }, 500)); // query fails

    try {
      await client.server.getTransactionLog({ since: "2026-06-01" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as TM1Error;
      expect(err.code).toBe(TM1ErrorCode.TM1_ERROR);
      expect(err.message).toContain("time range is too large");
      expect(err.hint).toContain("from-to");
    }
  });

  it("no `since`: a window failure stops widening and returns what was collected", async () => {
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe ok
      .mockResolvedValue(mockResponse({ error: { message: "boom" } }, 500)); // every window fails

    const { entries } = await client.server.getTransactionLog({ top: 5 });
    expect(entries).toEqual([]); // degraded, not thrown
  });

  it("no `since`: a PERMISSION_DENIED window rejects — never silently returns []", async () => {
    // The cheap unfiltered probe can succeed while a cubeName-filtered window
    // hits cube-level security. A denial must surface, not degrade to an empty
    // window that reads as "no transactions in range".
    fetchSpy
      .mockResolvedValueOnce(mockResponse({ value: [] })) // probe ok
      .mockResolvedValue(
        mockResponse({ error: { code: "65", message: "ObjectSecurityNoReadRights" } }, 400),
      ); // filtered window denied

    await expect(
      client.server.getTransactionLog({ cubeName: "SecretCube", top: 5 }),
    ).rejects.toMatchObject({ code: TM1ErrorCode.PERMISSION_DENIED });
  });
});
