import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

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
    keepAliveIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    logLevel: "info",
  } as unknown as TM1Config;
}

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// getAttributeValues builds MDX by interpolating the dimension and element names
// into bracketed identifiers. Names containing `]` must be doubled (`]]`) or they
// break out of the identifier (MDX injection, M8).
describe("ElementService.getAttributeValues — MDX identifier escaping (M8)", () => {
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

  it("doubles `]` in the dimension and element names", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ ID: "cs-1", Cells: [], Axes: [{ Tuples: [] }] }));

    await client.elements.getAttributeValues("Region]evil", "Foo]Bar");

    const firstCall = fetchSpy.mock.calls[0]!;
    const sentMdx = (JSON.parse(String((firstCall[1] as { body: string }).body)) as { MDX: string }).MDX;

    // Escaped forms present; raw single-`]` breakouts absent.
    expect(sentMdx).toContain("Foo]]Bar");
    expect(sentMdx).toContain("Region]]evil");
    expect(sentMdx).not.toContain("Foo]Bar]");
    expect(sentMdx).not.toContain("[Region]evil]");
  });
});
