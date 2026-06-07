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

function mockResponse(body: unknown): Response {
  const bodyText = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TM1Client – getAuditLog()", () => {
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

  it("fetches newest-first with default top=100 and maps fields", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          {
            ID: 3601,
            TimeStamp: "2026-06-07T04:40:47Z",
            UserName: "Admin",
            Description: "User 'Admin' logged in.",
            ObjectType: "Server",
            ObjectName: "SYSTEM",
          },
        ],
      }),
    );

    const entries = await client.server.getAuditLog({});

    const [url] = fetchSpy.mock.calls[0];
    const decoded = decodeURIComponent(String(url));
    expect(decoded).toContain("/api/v1/AuditLogEntries");
    expect(decoded).toContain("$orderby=TimeStamp desc");
    expect(decoded).toContain("$top=100");
    expect(decoded).not.toContain("$expand");

    expect(entries).toEqual([
      {
        id: 3601,
        timestamp: "2026-06-07T04:40:47Z",
        user: "Admin",
        description: "User 'Admin' logged in.",
        objectType: "Server",
        objectName: "SYSTEM",
      },
    ]);
  });

  it("builds $filter from user/objectType/objectName/since/until with quote escaping", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ value: [] }));

    await client.server.getAuditLog({
      user: "O'Brien",
      objectType: "Cube",
      objectName: "Sales",
      since: "2026-06-01T00:00:00Z",
      until: "2026-06-07T00:00:00Z",
      top: 25,
    });

    const [url] = fetchSpy.mock.calls[0];
    const decoded = decodeURIComponent(String(url));
    expect(decoded).toContain("UserName eq 'O''Brien'");
    expect(decoded).toContain("ObjectType eq 'Cube'");
    expect(decoded).toContain("ObjectName eq 'Sales'");
    expect(decoded).toContain("TimeStamp ge 2026-06-01T00:00:00Z");
    expect(decoded).toContain("TimeStamp le 2026-06-07T00:00:00Z");
    expect(decoded).toContain("$top=25");
  });

  it("expands AuditDetails when includeDetails is set and maps nested details", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        value: [
          {
            ID: 10,
            TimeStamp: "2026-06-07T05:00:00Z",
            UserName: "Admin",
            Description: "Dimension updated.",
            ObjectType: "Dimension",
            ObjectName: "Region",
            AuditDetails: [
              {
                ID: 11,
                TimeStamp: "2026-06-07T05:00:00Z",
                UserName: "Admin",
                Description: "Element 'West' added.",
                ObjectType: "Element",
                ObjectName: "West",
              },
            ],
          },
          {
            ID: 12,
            TimeStamp: "2026-06-07T05:01:00Z",
            UserName: "Admin",
            Description: "No details on this one.",
            ObjectType: "Server",
            ObjectName: "SYSTEM",
          },
        ],
      }),
    );

    const entries = await client.server.getAuditLog({ includeDetails: true });

    const [url] = fetchSpy.mock.calls[0];
    const decoded = decodeURIComponent(String(url));
    expect(decoded).toContain("$expand=AuditDetails");

    expect(entries[0].details).toEqual([
      {
        id: 11,
        timestamp: "2026-06-07T05:00:00Z",
        user: "Admin",
        description: "Element 'West' added.",
        objectType: "Element",
        objectName: "West",
      },
    ]);
    // Entry without AuditDetails key (server omits when empty) → no details field.
    expect(entries[1].details).toBeUndefined();
  });
});
