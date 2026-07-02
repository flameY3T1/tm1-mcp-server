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

function makeConfig(): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 60000,
    logLevel: "info",
  };
}

/** Build an error whose wrapped cause carries an OS-level `.code` (the undici shape). */
function fetchFailedWithCause(code: string): TypeError {
  const cause = Object.assign(new Error(`underlying ${code}`), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

/** Build a plain (non-TypeError) error carrying a cause `.code` and a message
 *  that contains none of the legacy substrings — isolates the cause-code path. */
function opaqueWrapperWithCause(code: string): Error {
  const cause = Object.assign(new Error(`underlying ${code}`), { code });
  return Object.assign(new Error("request pipeline failed"), { cause });
}

/**
 * isNetworkError is private; drive it through the retry loop. A safe GET retries
 * MAX_NETWORK_RETRIES times on a network error (fetch called >1) and fails fast
 * on a non-network error (fetch called exactly once). Fake timers skip backoff.
 */
async function fetchCallsFor(client: TM1HttpClient, err: unknown): Promise<number> {
  vi.useFakeTimers();
  try {
    const fetchSpy = vi.fn().mockRejectedValue(err);
    vi.stubGlobal("fetch", fetchSpy);
    const assertion = expect(
      client.request("GET", "/api/v1/Configuration"),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    return fetchSpy.mock.calls.length;
  } finally {
    vi.useRealTimers();
  }
}

describe("Watch-item #5: isNetworkError classifies via err.cause.code", () => {
  let client: TM1HttpClient;

  beforeEach(() => {
    const cfg = makeConfig();
    const sm = new SessionManager(cfg, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
    client = new TM1HttpClient(cfg, sm, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // undici wraps OS failures in `TypeError: fetch failed` with cause.code set.
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"]) {
    it(`retries a GET on cause.code=${code}`, async () => {
      const calls = await fetchCallsFor(client, fetchFailedWithCause(code));
      expect(calls).toBeGreaterThan(1);
    });
  }

  it("retries when only the cause carries the code (non-TypeError wrapper)", async () => {
    // Message has no legacy substring and it is not a TypeError, so the old
    // implementation would NOT have retried this — the cause-code path adds it.
    const calls = await fetchCallsFor(client, opaqueWrapperWithCause("ETIMEDOUT"));
    expect(calls).toBeGreaterThan(1);
  });

  it("retries when the error exposes `.code` directly (raw socket error)", async () => {
    const raw = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const calls = await fetchCallsFor(client, raw);
    expect(calls).toBeGreaterThan(1);
  });

  it("retries the `TypeError: fetch failed` fallback with no cause", async () => {
    const calls = await fetchCallsFor(client, new TypeError("fetch failed"));
    expect(calls).toBeGreaterThan(1);
  });

  it("does NOT retry a non-network error (fails fast)", async () => {
    const calls = await fetchCallsFor(client, new Error("boom: unexpected server state"));
    expect(calls).toBe(1);
  });
});
