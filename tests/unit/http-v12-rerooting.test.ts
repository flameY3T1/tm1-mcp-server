// Task 5 (v12 connection layer): TM1HttpClient must reroot every outbound
// request path through ConnectionProfile.resolveApiPath() so a v12 (Planning
// Analytics Engine) target gets `/{instance}/api/v1/Databases('{db}')/...`
// while v11 stays byte-identical (identity reroot, covered by the sibling
// http-network-error/http-mutation-events tests which use a v11 config).
//
// Harness copied from tests/unit/http-mutation-events.test.ts (mocked
// SessionManager.ensureSession + stubbed global fetch) — that is the file
// with the actual TM1HttpClient construction pattern; tests/unit/http-transport.test.ts
// (named in the task brief) tests the unrelated MCP Streamable HTTP transport
// (startHttpTransport), not TM1HttpClient, so it was not the right host file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
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

function makeV12Config(): TM1Config {
  return {
    baseUrl: "http://host:4444",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 60000,
    logLevel: "info",
    tm1Version: "12.0",
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 0,
    httpAllowedOrigins: [],
    mode: "readonly",
    version: 12,
    instance: "tm1",
    database: "db1",
    authMode: "s2s",
    clientId: "client-id",
    clientSecret: "client-secret",
  };
}

function okJsonResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue("{}"),
  } as unknown as Response;
}

describe("v12 rerooting: TM1HttpClient prefixes request paths with the database root", () => {
  let client: TM1HttpClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const cfg = makeV12Config();
    const sm = new SessionManager(cfg, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
    client = new TM1HttpClient(cfg, sm, mockLogger);

    fetchSpy = vi.fn().mockResolvedValue(okJsonResponse());
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("request(): rewrites /api/v1/... to the database-rooted path", async () => {
    await client.request("GET", "/api/v1/Cubes('Sales')");
    const url = fetchSpy.mock.calls.at(-1)![0];
    expect(url).toBe("http://host:4444/tm1/api/v1/Databases('db1')/Cubes('Sales')");
  });

  it("requestRaw(): rewrites /api/v1/... to the database-rooted path", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue("raw text"),
    } as unknown as Response);

    await client.requestRaw("GET", "/api/v1/Processes('P1')/ExecuteWithReturn");
    const url = fetchSpy.mock.calls.at(-1)![0];
    expect(url).toBe(
      "http://host:4444/tm1/api/v1/Databases('db1')/Processes('P1')/ExecuteWithReturn",
    );
  });

  it("requestBinary(): rewrites /api/v1/... to the database-rooted path", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response);

    await client.requestBinary(
      "PUT",
      "/api/v1/Contents('file.blob')/Content",
      new Uint8Array([1, 2, 3]),
    );
    const url = fetchSpy.mock.calls.at(-1)![0];
    expect(url).toBe(
      "http://host:4444/tm1/api/v1/Databases('db1')/Contents('file.blob')/Content",
    );
  });
});
