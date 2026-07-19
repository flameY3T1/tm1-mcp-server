import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";

// A3 regression: service version-gating must branch on the NUMERIC
// config.version (single source of truth), never on the tm1Version display
// string. The decisive case is the split-brain: version === 12 while the
// display string still reads "11.8" — the numeric must win.

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

function makeConfig(over: Partial<TM1Config>): TM1Config {
  return {
    baseUrl: "https://tm1server:8010",
    user: "admin",
    password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 5000,
    logLevel: "info",
    version: 11,
    tm1Version: "11.8",
    instance: "inst",
    database: "db",
    ...over,
  } as unknown as TM1Config;
}

function mock204Response(): Response {
  return {
    ok: true,
    status: 204,
    statusText: "No Content",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(""),
    json: vi.fn().mockRejectedValue(new Error("No content")),
  } as unknown as Response;
}

function makeClient(config: TM1Config): TM1Client {
  const sessionManager = new SessionManager(config, mockLogger);
  vi.spyOn(sessionManager, "ensureSession").mockResolvedValue("session123");
  vi.spyOn(sessionManager, "authenticate").mockResolvedValue("session123");
  return new TM1Client(config, sessionManager, mockLogger);
}

describe("A3 — service version-gating uses numeric config.version", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("v11: partial clear throws UNSUPPORTED_OPERATION (no tm1.Clear endpoint)", async () => {
    const client = makeClient(makeConfig({ version: 11, tm1Version: "11.8" }));
    await expect(
      client.cubes.clear("Sales", ["Region", "Month"], [["North"], []]),
    ).rejects.toMatchObject({ code: TM1ErrorCode.UNSUPPORTED_OPERATION });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("split-brain (version 12 but string '11.8'): partial clear takes the v12 tm1.Clear REST path", async () => {
    // If the branch keyed off the STRING, "11.8" would throw UNSUPPORTED_OPERATION.
    // Keyed off numeric version===12 it must POST tm1.Clear instead.
    fetchSpy.mockResolvedValue(mock204Response());
    const client = makeClient(makeConfig({ version: 12, tm1Version: "11.8" }));

    await expect(
      client.cubes.clear("Sales", ["Region", "Month"], [["North"], []]),
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("tm1.Clear");
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: "POST" });
  });

  it("exposes numeric version off the held HTTP client via the same source of truth", () => {
    // TM1Client.version and the http-client branch source agree (both config.version).
    expect(makeClient(makeConfig({ version: 12, tm1Version: "11.8" })).version).toBe(12);
    expect(makeClient(makeConfig({ version: 11, tm1Version: "11.8" })).version).toBe(11);
  });
});
