// P7 / K6 / T-9 — the catch-everything feature fallback.
//
// `ProcessService.fetchForCallgraph()` probes up to four OData query shapes.
// Before this suite it caught EVERY error and advanced to the next, broader
// query: an expired session, a request timeout or a security denial all bought
// three more full `/Processes` scans (~4 × 30 s worst case), and a later shape
// that happened to answer masked the real first error. A denial in particular
// degraded into an empty process list, which the callgraph then cached as
// "this model has no processes".
//
// The rules asserted here:
//   1. systemic failures (auth / transport / timeout) surface immediately,
//   2. permission denials surface immediately and never become an empty list,
//   3. only a query-SHAPE rejection advances to the next variant,
//   4. the shape that worked is remembered per connection, so the probe is
//      paid once instead of once per callgraph build.
//
// `ViewService.list()` had the same blanket-catch shape (view-service.ts:43)
// and is covered at the bottom of this file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubContractCheckedFetch } from "../helpers/contract-fetch.js";
import type pino from "pino";
import type { FnSpy } from "../helpers/spy-types.js";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

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
} as unknown as pino.Logger;

function makeConfig(): TM1Config {
  return {
    ...baseTestConfig,
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

/** TM1 refusing the query SHAPE — an unparsable $select/$expand comes back 400. */
const shapeRejection = (): Response =>
  mockResponse(
    { error: { message: "Invalid $select clause: 'Parameters'" } },
    400,
  );

/**
 * TM1 signals object-level security denial through the error MESSAGE, usually
 * with HTTP 400 rather than 403 (verified live against a cube-only user), so
 * this is the realistic denial fixture — not a 403.
 */
const securityDenial = (): Response =>
  mockResponse(
    { error: { code: "65", message: "ObjectSecurityNoReadRights" } },
    400,
  );

const processPayload = (): Response =>
  mockResponse({
    value: [
      {
        Name: "Load.Sales",
        PrologProcedure: "sPath='x';",
        MetadataProcedure: "",
        DataProcedure: "",
        EpilogProcedure: "",
        Parameters: [{ Name: "pYear", Value: "2024", Type: "String" }],
      },
    ],
  });

describe("ProcessService.fetchForCallgraph — fallback discipline (P7/K6/T-9)", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
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

  it("does not advance to the next query variant on an auth failure", async () => {
    // 401 twice: the HTTP layer re-authenticates once and retries, then gives
    // up with AUTH_FAILED. That is two fetches for ONE query shape — if the
    // fallback advanced, we would see the shapes keep marching.
    fetchSpy.mockResolvedValue(mockResponse({ error: "expired" }, 401));

    await expect(client.processes.fetchForCallgraph()).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not advance to the next query variant on a request timeout", async () => {
    // Worst case before the fix: 4 × the request timeout before the caller
    // learned anything.
    fetchSpy.mockRejectedValue(
      new DOMException("Request timed out", "TimeoutError"),
    );

    await expect(client.processes.fetchForCallgraph()).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a permission denial instead of degrading to an empty process list", async () => {
    // T-9 names exactly this: "Permission-Denial wird zu leerer Collection".
    // An empty list here is indistinguishable from "the model has no
    // processes" and gets cached by the callgraph as truth.
    fetchSpy.mockResolvedValue(securityDenial());

    await expect(client.processes.fetchForCallgraph()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("still falls back when the server rejects the query SHAPE", async () => {
    // The one error class the fallback exists for: an older/stricter TM1 that
    // cannot parse this $select. Then, and only then, try the next variant.
    fetchSpy
      .mockResolvedValueOnce(shapeRejection())
      .mockResolvedValueOnce(processPayload());

    const rows = await client.processes.fetchForCallgraph();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Load.Sales");
    expect(rows[0]?.parameters).toEqual(["pYear"]);
  });

  it("reuses the query variant that worked on a second call", async () => {
    // P7: the probe must be paid once per connection, not once per callgraph
    // build. Variant 0 is rejected, variant 1 answers — the next call must go
    // straight to variant 1 with a single round trip.
    fetchSpy
      .mockResolvedValueOnce(shapeRejection())
      .mockResolvedValueOnce(processPayload());

    await client.processes.fetchForCallgraph();
    const learnedUrl = fetchSpy.mock.calls[1]?.[0] as string;

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(processPayload());
    await client.processes.fetchForCallgraph();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(learnedUrl);
  });

  it("re-probes the shape but keeps the filter when includeControl flips", async () => {
    // The cached verdict is about the QUERY SHAPE, not about the filter — the
    // remembered variant has to be reusable for both includeControl values.
    fetchSpy.mockResolvedValueOnce(processPayload());
    await client.processes.fetchForCallgraph(false);

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValueOnce(processPayload());
    await client.processes.fetchForCallgraph(true);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain("startswith");
  });

  it("throws the last shape rejection when no variant is accepted", async () => {
    fetchSpy.mockResolvedValue(shapeRejection());

    await expect(client.processes.fetchForCallgraph()).rejects.toThrow(
      /Invalid \$select clause/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("surfaces a real error on a variant that already worked, instead of re-walking the list", async () => {
    fetchSpy.mockResolvedValueOnce(processPayload());
    await client.processes.fetchForCallgraph();

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(securityDenial());
    await expect(client.processes.fetchForCallgraph()).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ViewService.list — permission denial must not read as 'no views' (T-9)", () => {
  let fetchSpy: FnSpy;
  let client: TM1Client;

  beforeEach(() => {
    fetchSpy = vi.fn();
    stubContractCheckedFetch(fetchSpy);
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

  it("propagates a security denial rather than returning an empty view list", async () => {
    fetchSpy.mockResolvedValue(securityDenial());

    await expect(client.views.list("Sales")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("still omits a scope the server genuinely does not have (404)", async () => {
    // The case the blanket catch was written for: PrivateViews absent on this
    // server. "Feature not present" stays a skip, not an error.
    fetchSpy.mockResolvedValue(mockResponse({ error: "not found" }, 404));

    await expect(client.views.list("Sales")).resolves.toEqual([]);
  });

  it("returns the public scope when only the private one is missing", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        mockResponse({ value: [{ Name: "Default", MDX: "SELECT" }] }),
      )
      .mockResolvedValueOnce(mockResponse({ error: "not found" }, 404));

    await expect(client.views.list("Sales")).resolves.toEqual([
      { name: "Default", mdx: "SELECT", private: false },
    ]);
  });
});
