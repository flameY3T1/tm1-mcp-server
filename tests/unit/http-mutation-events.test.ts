import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import { tm1Events, type Tm1MutationEvent } from "../../src/lib/tm1-events.js";

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

describe("R2-05: HTTP layer emits mutation events", () => {
  let client: TM1HttpClient;
  let events: Tm1MutationEvent[];
  let listener: (e: Tm1MutationEvent) => void;

  beforeEach(() => {
    const cfg = makeConfig();
    const sm = new SessionManager(cfg, mockLogger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("cookie");
    client = new TM1HttpClient(cfg, sm, mockLogger);

    events = [];
    listener = (e) => events.push(e);
    tm1Events.on("mutation", listener);
  });

  afterEach(() => {
    tm1Events.off("mutation", listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("emits on successful POST", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 204, statusText: "No Content",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response));

    await client.request("POST", "/api/v1/Dimensions", { Name: "Test" });
    expect(events).toEqual([{ method: "POST", path: "/api/v1/Dimensions" }]);
  });

  it("emits on successful DELETE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 204, statusText: "No Content",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response));

    await client.request("DELETE", "/api/v1/Cubes('Old')");
    expect(events).toEqual([{ method: "DELETE", path: "/api/v1/Cubes('Old')" }]);
  });

  it("does not emit on GET (safe method)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue("{}"),
    } as unknown as Response));

    await client.request("GET", "/api/v1/Configuration");
    expect(events).toEqual([]);
  });

  it("does not emit when request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, statusText: "Server Error",
      headers: new Headers(),
      text: vi.fn().mockResolvedValue("boom"),
    } as unknown as Response));

    await expect(client.request("POST", "/api/v1/Bad")).rejects.toThrow();
    expect(events).toEqual([]);
  });
});
