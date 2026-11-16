// Review 2026-10-22, F1 + F4. The timeout and the caller's cancel used to end
// when the response HEADERS arrived; the body was read afterwards with no
// deadline. Reproduced against a real server that sends headers and then
// stalls: every request path hung past its 400 ms budget.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pino from "pino";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager, TimeoutError } from "../../src/session-manager.js";
import { freeCellset } from "../../src/tm1-client/services/cellset-transform.js";
import type { TM1Config } from "../../src/config.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const logger = {
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

const config: TM1Config = {
  ...baseTestConfig,
  baseUrl: "https://tm1server:8010",
  user: "admin",
  password: "secret",
  requestTimeoutMs: 30,
};

// Headers at once, a body that never finishes. Like undici, the pending read
// rejects with the signal's reason once the request signal aborts.
function stalledBody(status = 200) {
  return vi.fn((_url: string, init: RequestInit) => {
    const read = () =>
      new Promise<never>((_, reject) => {
        const signal = init.signal!;
        const fail = () => reject(signal.reason as Error);
        if (signal.aborted) fail();
        signal.addEventListener("abort", fail);
      });
    return Promise.resolve({
      ok: status < 400,
      status,
      statusText: "",
      headers: new Headers({ "set-cookie": "TM1SessionId=abc" }),
      text: read,
      arrayBuffer: read,
    } as unknown as Response);
  });
}

// Fails the test instead of hanging the suite when the deadline is not applied.
function within<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("still hanging")), ms),
    ),
  ]);
}

describe("deadline covers the response body (F1)", () => {
  let client: TM1HttpClient;
  let fetchSpy: ReturnType<typeof stalledBody>;

  beforeEach(() => {
    const sm = new SessionManager(config, logger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("c");
    client = new TM1HttpClient(config, sm, logger);
    fetchSpy = stalledBody();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("times a GET out while the body stalls, without retrying it", async () => {
    await expect(
      within(client.request("GET", "/api/v1/Cubes")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("times a POST out while the body stalls, sending it once", async () => {
    await expect(
      within(client.request("POST", "/api/v1/ExecuteMDX", { MDX: "x" })),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("honours a client cancel that arrives during the body", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(
      within(
        client.request("GET", "/api/v1/Cubes", undefined, {
          timeoutMs: 60000,
          signal: ctl.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("times the raw text and raw byte reads out as well", async () => {
    await expect(
      within(client.requestRaw("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    await expect(
      within(client.requestRawBytes("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  it("answers with the HTTP error when an error body stalls", async () => {
    vi.stubGlobal("fetch", stalledBody(500));
    await expect(
      within(client.request("POST", "/api/v1/x", {})),
    ).rejects.toMatchObject({ httpStatus: 500 });
    await expect(
      within(client.requestRaw("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ httpStatus: 500 });
  });

  it("gives the body a fresh budget once the headers are in", async () => {
    // 20 ms to the headers + 20 ms of body exceeds the 30 ms budget in total,
    // but TM1 was never silent for 30 ms.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await wait(20);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: async () => {
            await wait(20);
            return '{"a":1}';
          },
        } as unknown as Response;
      }),
    );
    await expect(within(client.request("GET", "/api/v1/x"))).resolves.toEqual({
      a: 1,
    });
  });

  // A streamed body: one chunk per entry of `gaps` (ms before it), cut off
  // with the signal's reason like a real transport.
  function streamed(gaps: number[]) {
    return vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal.addEventListener("abort", () =>
            controller.error(signal.reason),
          );
          const enc = new TextEncoder();
          controller.enqueue(enc.encode("["));
          for (const [i, gap] of gaps.entries()) {
            await new Promise((r) => setTimeout(r, gap));
            if (signal.aborted) return;
            controller.enqueue(enc.encode(`${i ? "," : ""}${i}`));
          }
          controller.enqueue(enc.encode("]"));
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
  }

  it("lets a body that keeps streaming run past the budget", async () => {
    // 8 chunks 15 ms apart = 120 ms of body against a 30 ms budget. Measured
    // live: a 72 MB cellset needs 2.4 s of body and died at a 1 s budget.
    vi.stubGlobal("fetch", streamed(Array<number>(8).fill(15)));
    await expect(within(client.request("GET", "/api/v1/x"))).resolves.toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    vi.stubGlobal("fetch", streamed(Array<number>(8).fill(15)));
    await expect(within(client.requestRaw("GET", "/api/v1/x"))).resolves.toBe(
      "[0,1,2,3,4,5,6,7]",
    );
  });

  it("times out when the stream falls silent for longer than the budget", async () => {
    vi.stubGlobal("fetch", streamed([10, 200, 10]));
    await expect(
      within(client.request("GET", "/api/v1/x")),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
  });

  it("times the login out while its body stalls", async () => {
    await expect(
      within(new SessionManager(config, logger).authenticate()),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

// Review 2026-11-16, R4. Measured against undici: a 1 MB or unfinished body
// that nobody reads keeps its connection; a cancel releases it.
describe("a body the reader leaves alone is released", () => {
  let client: TM1HttpClient;

  // A body that stays open, as a gateway's login page on a 401 can.
  function openBody(status: number, cancelled: () => void) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x"));
      },
      cancel: cancelled,
    });
    return new Response(body, { status });
  }

  beforeEach(() => {
    const sm = new SessionManager(config, logger);
    vi.spyOn(sm, "ensureSession").mockResolvedValue("c");
    vi.spyOn(sm, "authenticate").mockResolvedValue("c2");
    client = new TM1HttpClient(config, sm, logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["request", () => client.request("GET", "/api/v1/x")],
    ["requestRaw", () => client.requestRaw("GET", "/api/v1/x")],
  ])("cancels the 401 body before the re-auth (%s)", async (_name, call) => {
    const cancelled = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(openBody(401, cancelled))
        .mockResolvedValueOnce(new Response('{"a":1}', { status: 200 })),
    );
    await within(call());
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });

  it("cancels the answer to an upload, which nobody reads", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(openBody(200, cancelled)));
    await within(client.requestBinary("PUT", "/api/v1/x", new Uint8Array([1])));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});

describe("freeCellset after a cancelled request (F4)", () => {
  it("still releases the cellset, without the caller's aborted signal", async () => {
    // Reproduced live: the DELETE inherited the aborted signal, was never
    // sent, and the cellset stayed on the server.
    const request = vi.fn().mockResolvedValue(undefined);
    await freeCellset({ request, logger } as unknown as TM1HttpClient, "abc");
    expect(request).toHaveBeenCalledOnce();
    const [method, path, , opts] = request.mock.calls[0];
    expect(method).toBe("DELETE");
    expect(path).toBe("/api/v1/Cellsets('abc')");
    expect(opts?.signal).toBeUndefined();
    expect(opts?.timeoutMs).toBeLessThanOrEqual(10000);
  });

  it("never throws and reports a failed release", async () => {
    const warn = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error("gone"));
    await expect(
      freeCellset(
        { request, logger: { warn } } as unknown as TM1HttpClient,
        "abc",
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
