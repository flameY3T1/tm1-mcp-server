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

describe("R2-03: AbortSignal propagation through HTTP layer", () => {
  let sessionManager: SessionManager;
  let client: TM1HttpClient;

  beforeEach(() => {
    const cfg = makeConfig();
    sessionManager = new SessionManager(cfg, mockLogger);
    vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session-cookie");
    client = new TM1HttpClient(cfg, sessionManager, mockLogger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("aborts in-flight fetch when external signal aborts", async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const external = new AbortController();
    const promise = client.request("GET", "/api/v1/Configuration", undefined, { signal: external.signal });

    queueMicrotask(() => external.abort(new Error("user cancelled")));

    await expect(promise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not abort when external signal is omitted (timeout-only path)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue('{"ok":true}'),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    await client.request("GET", "/api/v1/Configuration");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.signal?.aborted).toBe(false);
  });

  it("aborts immediately when external signal is already aborted", async () => {
    const fetchSpy = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        return Promise.reject(err);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: vi.fn().mockResolvedValue("{}"),
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const external = new AbortController();
    external.abort(new Error("pre-aborted"));

    await expect(
      client.request("GET", "/api/v1/Configuration", undefined, { signal: external.signal }),
    ).rejects.toThrow();
  });
});
