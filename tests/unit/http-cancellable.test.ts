// A request TM1 has received runs to its end whatever the client does. The
// cancellable path runs it as an asynchronous operation instead, so a timeout
// or a caller's abort can take it back. The wire behaviour pinned here was
// measured on 11.8 and v12 (2026-11-17): 202 + Location on the POST, 202 while
// working, then HTTP 200 with the real status in `asyncresult`, DELETE to
// cancel or release.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pino from "pino";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
} as unknown as pino.Logger;

const HANDLE = "_async('h1')";
const accepted = () =>
  new Response(null, { status: 202, headers: { Location: HANDLE } });
const pending = () => new Response(null, { status: 202 });
const result = (asyncresult: string, body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { asyncresult } });

type Call = { method: string; url: string; prefer: string | undefined };

function setup(
  version: 11 | 12,
  answer: (call: Call, n: number) => Response | Promise<Response>,
  requestTimeoutMs = 60000,
) {
  const cfg = {
    ...baseTestConfig,
    baseUrl: "https://tm1server:8010",
    version,
    requestTimeoutMs,
  };
  const sm = new SessionManager(cfg, mockLogger);
  vi.spyOn(sm, "ensureSession").mockResolvedValue("session-cookie");
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = {
        method: init.method ?? "GET",
        url: url.replace("https://tm1server:8010", ""),
        prefer: (init.headers as Record<string, string>).Prefer,
      };
      calls.push(call);
      return answer(call, calls.length);
    }),
  );
  return { client: new TM1HttpClient(cfg, sm, mockLogger), calls };
}

const run = (client: TM1HttpClient, opts = {}) =>
  client.request(
    "POST",
    "/api/v1/ExecuteMDX",
    { MDX: "SELECT" },
    {
      cancellable: true,
      ...opts,
    },
  );
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TM1HttpClient, cancellable request", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("polls the handle, returns the body and releases the result", async () => {
    const { client, calls } = setup(11, (c, n) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? new Response(null, { status: 204 })
          : n < 4
            ? pending()
            : result("201 Created", { ID: "c1" }),
    );
    await expect(run(client)).resolves.toEqual({ ID: "c1" });
    await flush();
    expect(calls[0]).toMatchObject({ method: "POST", prefer: "respond-async" });
    expect(calls.map((c) => `${c.method} ${c.url}`).slice(1)).toEqual([
      `GET /api/v1/${HANDLE}`,
      `GET /api/v1/${HANDLE}`,
      `GET /api/v1/${HANDLE}`,
      `DELETE /api/v1/${HANDLE}`,
    ]);
  });

  it("finds the handle behind a Location relative to a nested request path", async () => {
    // A view's tm1.Execute answers `../../_async('<id>')`; taking the header as
    // a path below /api/v1/ gave a 404 on every view read (found live).
    const { client, calls } = setup(11, (c) =>
      c.method === "POST"
        ? new Response(null, {
            status: 202,
            headers: { Location: `../../${HANDLE}` },
          })
        : c.method === "DELETE"
          ? new Response(null, { status: 204 })
          : result("201 Created", { ID: "c1" }),
    );
    await client.request(
      "POST",
      "/api/v1/Cubes('C')/Views('V')/tm1.Execute",
      undefined,
      { cancellable: true },
    );
    expect(calls[1]?.url).toBe(`/api/v1/${HANDLE}`);
  });

  it("does not announce a model mutation when it releases the handle", async () => {
    const { tm1Events } = await import("../../src/lib/tm1-events.js");
    const seen: string[] = [];
    const on = (e: { path: string }): void => void seen.push(e.path);
    tm1Events.on("mutation", on);
    try {
      const { client } = setup(11, (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response(null, { status: 204 })
            : result("201 Created", { ID: "c1" }),
      );
      await run(client);
      await flush();
      expect(seen).toEqual(["/api/v1/ExecuteMDX"]);
    } finally {
      tm1Events.off("mutation", on);
    }
  });

  it("names the handle when TM1 no longer knows it, instead of blaming the request path", async () => {
    const { client } = setup(11, (c) =>
      c.method === "POST" ? accepted() : new Response(null, { status: 404 }),
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "TM1_ERROR",
      endpoint: `/api/v1/${HANDLE}`,
      message: expect.stringMatching(/lost the asynchronous operation/),
    });
  });

  it("keeps the cancel outcome through a tool's own hint", async () => {
    const { withToolHint } = await import("../../src/tools/error-format.js");
    const { client } = setup(
      12,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response(null, { status: 204 })
            : pending(),
      120,
    );
    await expect(
      withToolHint(run(client), "MDX execution failed. Common causes: …"),
    ).rejects.toMatchObject({
      cancelled: true,
      hint: expect.stringMatching(/accepted the cancel/),
    });
  });

  it("judges the result by asyncresult, not by the HTTP 200 it arrives with", async () => {
    const { client, calls } = setup(11, (c) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? new Response(null, { status: 204 })
          : result("404 Not Found", { error: { message: "no such cube" } }),
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
      message: "no such cube",
    });
    await flush();
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("reads the bare number v12 sends in asyncresult", async () => {
    const { client } = setup(12, (c) =>
      c.method === "POST"
        ? accepted()
        : c.method === "DELETE"
          ? new Response(null, { status: 204 })
          : result("400", { error: { message: "bad mdx" } }),
    );
    await expect(run(client)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("takes a direct answer from a server that ignores the preference", async () => {
    const { client, calls } = setup(
      11,
      () => new Response(JSON.stringify({ ID: "c1" }), { status: 201 }),
    );
    await expect(run(client)).resolves.toEqual({ ID: "c1" });
    expect(calls).toHaveLength(1);
  });

  it("cancels on timeout and says the query was stopped on v11", async () => {
    const { client, calls } = setup(
      11,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response(null, { status: 204 })
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
      cancelled: true,
      hint: expect.stringMatching(/was cancelled on the server/),
    });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("does not claim a stop on v12, where a cancel may run to the end", async () => {
    const { client } = setup(
      12,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response(null, { status: 204 })
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      cancelled: true,
      hint: expect.stringMatching(/accepted the cancel.*tm1_list_jobs/),
    });
  });

  it("reports an unconfirmed cancel as such", async () => {
    const { client } = setup(
      11,
      (c) =>
        c.method === "POST"
          ? accepted()
          : c.method === "DELETE"
            ? new Response("{}", { status: 500 })
            : pending(),
      120,
    );
    await expect(run(client)).rejects.toMatchObject({
      cancelled: false,
      hint: expect.stringMatching(/may still be running.*tm1_list_threads/),
    });
  });

  it("cancels on the server when the caller aborts", async () => {
    const ac = new AbortController();
    const { client, calls } = setup(11, (c, n) => {
      if (c.method === "POST") return accepted();
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (n === 3) {
        ac.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return pending();
    });
    await expect(run(client, { signal: ac.signal })).rejects.toThrow(/aborted/);
    await flush();
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: `/api/v1/${HANDLE}`,
    });
  });

  it("leaves a plain request untouched", async () => {
    const { client, calls } = setup(
      11,
      () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    );
    await client.request("POST", "/api/v1/ExecuteMDX", { MDX: "SELECT" });
    expect(calls).toEqual([
      { method: "POST", url: "/api/v1/ExecuteMDX", prefer: undefined },
    ]);
  });
});
