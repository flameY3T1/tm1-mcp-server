import { describe, it, expect } from "vitest";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import {
  BATCH_MAX_PAYLOAD_BYTES,
  BATCH_MAX_REQUESTS,
  BATCH_PROBE_ID,
  BatchService,
  BatchUnsupportedError,
} from "../../src/tm1-client/services/batch-service.js";
import type { BatchRequest } from "../../src/tm1-client/services/batch-service.js";

// BatchService owns POST /api/v1/$batch. The shapes pinned here were captured
// live against TM1 v11 11.8.02900.8 and v12/PA Engine 12.5.9:
//   - JSON batch envelope {requests:[...]} -> 200 {responses:[{id,status,body}]}
//   - the envelope is 200 even when sub-requests fail
//   - continue-on-error is the default; a failure does not stop later requests
// A sub-request failure is therefore DATA (ok:false), never a thrown error.

type Sent = { method: string; path: string; body?: unknown; opts?: unknown };

interface FakeOpts {
  respond?: (payload: { requests: Array<Record<string, unknown>> }) => unknown;
  throwOnBatch?: Error;
}

function makeService(opts: FakeOpts = {}): { svc: BatchService; sent: Sent[] } {
  const sent: Sent[] = [];
  const http = {
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      o?: unknown,
    ): Promise<T> {
      sent.push({ method, path, body, opts: o });
      if (opts.throwOnBatch) throw opts.throwOnBatch;
      const payload = body as { requests: Array<Record<string, unknown>> };
      if (opts.respond) return opts.respond(payload) as T;
      // Default: echo every sub-request back as a 200.
      return {
        responses: payload.requests.map((r) => ({
          id: r.id,
          status: 200,
          body: { echo: r.url },
        })),
      } as T;
    },
  } as unknown as TM1HttpClient;
  return { svc: new BatchService(http), sent };
}

const req = (id: string, extra: Partial<BatchRequest> = {}): BatchRequest => ({
  id,
  method: "GET",
  path: "/api/v1/Cubes",
  ...extra,
});

type Payload = { requests: Array<Record<string, unknown>> };

/** The counter-probe envelope: exactly one sub-request, carrying the probe id. */
const isProbePayload = (payload: Payload): boolean =>
  payload.requests.length === 1 && payload.requests[0].id === BATCH_PROBE_ID;
const isProbe = (s: Sent): boolean => isProbePayload(s.body as Payload);

/** What a server WITH a working $batch answers the probe with. */
const probeEnvelope = (): unknown => ({
  responses: [
    { id: BATCH_PROBE_ID, status: 200, body: { value: "11.8.02900.8" } },
  ],
});
const echoEnvelope = (payload: Payload): unknown => ({
  responses: payload.requests.map((r) => ({
    id: r.id,
    status: 200,
    body: { echo: r.url },
  })),
});
/** A 400 caused by the PAYLOAD, not by a missing endpoint. */
const payload400 = (): TM1Error =>
  new TM1Error({
    code: TM1ErrorCode.TM1_ERROR,
    message: "duplicate sub-request id",
    httpStatus: 400,
  });

describe("BatchService — payload construction", () => {
  it("posts to $batch with service-root-relative sub-URLs", async () => {
    const { svc, sent } = makeService();
    await svc.execute([
      req("a", {
        method: "POST",
        path: "/api/v1/Dimensions('D')/Hierarchies('D')/Elements",
        body: { Name: "e1" },
      }),
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].path).toBe("/api/v1/$batch");
    const payload = sent[0].body as {
      requests: Array<Record<string, unknown>>;
    };
    expect(payload.requests[0]).toEqual({
      id: "a",
      method: "POST",
      // "/api/v1/" stripped — sub-URLs are relative to the batch service root,
      // which is what makes the same payload work against a v12 database root.
      url: "Dimensions('D')/Hierarchies('D')/Elements",
      headers: { "Content-Type": "application/json" },
      body: { Name: "e1" },
    });
  });

  it("omits body and Content-Type for bodyless requests", async () => {
    const { svc, sent } = makeService();
    await svc.execute([
      req("a", { method: "DELETE", path: "/api/v1/Cubes('C')" }),
    ]);
    const payload = sent[0].body as {
      requests: Array<Record<string, unknown>>;
    };
    expect(payload.requests[0]).toEqual({
      id: "a",
      method: "DELETE",
      url: "Cubes('C')",
    });
    expect(payload.requests[0]).not.toHaveProperty("body");
  });

  it("scales the timeout with the chunk size (a batch is N ops in one call)", async () => {
    const { svc, sent } = makeService();
    await svc.execute([req("a"), req("b")]);
    expect(sent[0].opts).toEqual({ timeoutMs: 30_000 + 2 * 200 });
  });

  it("returns an empty result without any HTTP call for zero requests", async () => {
    const { svc, sent } = makeService();
    await expect(svc.execute([])).resolves.toEqual([]);
    expect(sent).toHaveLength(0);
  });
});

describe("BatchService — chunking", () => {
  it(`splits into round-trips of at most ${BATCH_MAX_REQUESTS} sub-requests`, async () => {
    const { svc, sent } = makeService();
    const n = BATCH_MAX_REQUESTS * 2 + 3;
    const results = await svc.execute(
      Array.from({ length: n }, (_, i) => req(String(i))),
    );

    expect(sent).toHaveLength(3);
    const sizes = sent.map(
      (s) => (s.body as { requests: unknown[] }).requests.length,
    );
    expect(sizes).toEqual([BATCH_MAX_REQUESTS, BATCH_MAX_REQUESTS, 3]);
    // Results stay in request order across chunk boundaries.
    expect(results).toHaveLength(n);
    expect(results.map((r) => r.id)).toEqual(
      Array.from({ length: n }, (_, i) => String(i)),
    );
  });
});

// A chunk bounded only by request COUNT can still exceed a reverse proxy's or
// TM1's request-body limit (200 sub-requests with long element names is easily
// megabytes). The resulting 400/413 would then be misread as "this server has
// no $batch" and silently re-drive every write down the fallback path. So the
// chunk builder has to close a chunk on EITHER cap.
describe("BatchService — chunking by payload size", () => {
  const sizes = (sent: Sent[]): number[] =>
    sent.map((s) => (s.body as { requests: unknown[] }).requests.length);

  /** One sub-request whose body dominates its serialized size. */
  const bigReq = (id: string, chars: number, filler = "x"): BatchRequest =>
    req(id, {
      method: "POST",
      path: "/api/v1/Dimensions('D')/Hierarchies('D')/Elements",
      body: { blob: filler.repeat(chars) },
    });

  it("keeps the count cap in charge while the sub-requests are small", async () => {
    const { svc, sent } = makeService();
    // 250 tiny requests are nowhere near the byte budget, so the split must
    // still happen exactly at the count cap.
    await svc.execute(
      Array.from({ length: BATCH_MAX_REQUESTS + 50 }, (_, i) =>
        req(String(i), { method: "POST", body: { Name: `e${i}` } }),
      ),
    );
    expect(sizes(sent)).toEqual([BATCH_MAX_REQUESTS, 50]);
  });

  it("closes a chunk early when the byte budget would be exceeded", async () => {
    const { svc, sent } = makeService();
    // ~40% of the budget each: two fit, a third would overshoot.
    const chars = Math.floor(BATCH_MAX_PAYLOAD_BYTES * 0.4);
    const results = await svc.execute(
      Array.from({ length: 5 }, (_, i) => bigReq(String(i), chars)),
    );

    expect(sizes(sent)).toEqual([2, 2, 1]);
    // Every chunk actually stayed under the budget on the wire.
    for (const s of sent) {
      expect(Buffer.byteLength(JSON.stringify(s.body), "utf8")).toBeLessThan(
        BATCH_MAX_PAYLOAD_BYTES,
      );
    }
    // The split points are where they are because of bytes, not count.
    expect(results.map((r) => r.id)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("sends a single oversized sub-request alone rather than dropping it", async () => {
    const { svc, sent } = makeService();
    const monster = bigReq("big", BATCH_MAX_PAYLOAD_BYTES + 1_000);
    const results = await svc.execute([req("before"), monster, req("after")]);

    // It cannot share a chunk with anything, but it must still go out — and the
    // builder must make progress rather than spin on a chunk it can never fill.
    expect(sizes(sent)).toEqual([1, 1, 1]);
    const middle = (sent[1].body as { requests: Array<{ id: string }> })
      .requests;
    expect(middle.map((r) => r.id)).toEqual(["big"]);
    expect(results.map((r) => r.id)).toEqual(["before", "big", "after"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("counts BYTES, not characters, for multi-byte names", async () => {
    // 30% of the budget in CHARACTERS: three of them fit by String.length but
    // blow the budget by ~1.8x once the umlauts are UTF-8 encoded.
    const chars = Math.floor(BATCH_MAX_PAYLOAD_BYTES * 0.3);

    const ascii = makeService();
    await ascii.svc.execute(
      Array.from({ length: 3 }, (_, i) => bigReq(String(i), chars, "x")),
    );
    expect(sizes(ascii.sent)).toEqual([3]);

    const utf8 = makeService();
    await utf8.svc.execute(
      Array.from({ length: 3 }, (_, i) => bigReq(String(i), chars, "ä")),
    );
    // Same character count, two bytes per character -> one per chunk.
    expect(sizes(utf8.sent)).toEqual([1, 1, 1]);
  });

  it("keeps results in input order across a byte-driven split", async () => {
    // Respond in reverse within every chunk: order must come from the input,
    // never from the wire.
    const { svc, sent } = makeService({
      respond: (payload) => ({
        responses: [...payload.requests].reverse().map((r) => ({
          id: r.id,
          status: 200,
          body: { echo: r.id },
        })),
      }),
    });
    const chars = Math.floor(BATCH_MAX_PAYLOAD_BYTES * 0.4);
    const results = await svc.execute(
      Array.from({ length: 5 }, (_, i) => bigReq(`r${i}`, chars)),
    );

    expect(sizes(sent)).toEqual([2, 2, 1]);
    expect(results.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(results.map((r) => (r.ok ? r.body : null))).toEqual(
      ["r0", "r1", "r2", "r3", "r4"].map((id) => ({ echo: id })),
    );
  });

  it("scales each chunk's timeout with that chunk's own size", async () => {
    // Chunks are variable-length now, so the per-chunk budget has to be derived
    // per chunk — a fixed 200-request budget would be far too generous for the
    // 1-request chunk a huge sub-request produces.
    const { svc, sent } = makeService();
    const chars = Math.floor(BATCH_MAX_PAYLOAD_BYTES * 0.4);
    await svc.execute(
      Array.from({ length: 5 }, (_, i) => bigReq(String(i), chars)),
    );
    expect(sent.map((s) => s.opts)).toEqual([
      { timeoutMs: 30_000 + 2 * 200 },
      { timeoutMs: 30_000 + 2 * 200 },
      { timeoutMs: 30_000 + 1 * 200 },
    ]);
  });
});

describe("BatchService — sub-response mapping", () => {
  it("reports per-request success and failure instead of throwing (partial success)", async () => {
    // Live-observed: [ok, fail, ok] -> all three run, both successes commit.
    const { svc } = makeService({
      respond: () => ({
        responses: [
          { id: "0", status: 201, body: { Name: "e0" } },
          {
            id: "1",
            status: 400,
            body: {
              error: {
                code: "278",
                message: 'An element with name "seed" already exists.',
              },
            },
          },
          { id: "2", status: 201, body: { Name: "e2" } },
        ],
      }),
    });

    const results = await svc.execute([req("0"), req("1"), req("2")]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    const failed = results[1];
    if (failed.ok) throw new Error("expected a failure");
    expect(failed.status).toBe(400);
    expect(failed.error).toBeInstanceOf(TM1Error);
    expect(failed.error.message).toContain("already exists");
    expect(failed.error.httpStatus).toBe(400);
    // Endpoint is the caller's real path, not "$batch", so the error reads the
    // same as it would from a standalone request.
    expect(failed.error.endpoint).toBe("/api/v1/Cubes");
  });

  it("classifies sub-errors exactly like a standalone request", async () => {
    const { svc } = makeService({
      respond: () => ({
        responses: [
          {
            id: "0",
            status: 404,
            body: { error: { message: "'X' can not be found" } },
          },
          { id: "1", status: 409, body: { error: { message: "conflict" } } },
          // Security denial arrives as HTTP 400 with the reason in the message.
          {
            id: "2",
            status: 400,
            body: { error: { message: "ObjectSecurityNoReadRights" } },
          },
        ],
      }),
    });
    const [notFound, conflict, denied] = await svc.execute([
      req("0"),
      req("1"),
      req("2"),
    ]);
    if (notFound.ok || conflict.ok || denied.ok)
      throw new Error("expected failures");
    expect(notFound.error.code).toBe(TM1ErrorCode.NOT_FOUND);
    expect(conflict.error.code).toBe(TM1ErrorCode.CONFLICT);
    expect(denied.error.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
  });

  it("unwraps the nested OData message.value error shape", async () => {
    const { svc } = makeService({
      respond: () => ({
        responses: [
          {
            id: "0",
            status: 400,
            body: { error: { message: { value: "deep text" } } },
          },
        ],
      }),
    });
    const [r] = await svc.execute([req("0")]);
    if (r.ok) throw new Error("expected a failure");
    expect(r.error.message).toBe("deep text");
  });

  // handleResponse() ends its extraction with `?? errorBody`, so an unfamiliar
  // shape still reaches the caller as text. Dropping that fallback here would
  // downgrade a recognisable "already exists" into a generic TM1_ERROR and
  // break bulk upsert's idempotency.
  it("falls back to the raw body text when the error shape is unrecognised", async () => {
    const { svc } = makeService({
      respond: () => ({
        responses: [
          {
            id: "0",
            status: 400,
            body: { Message: 'An element with name "seed" already exists.' },
          },
        ],
      }),
    });
    const [r] = await svc.execute([req("0")]);
    if (r.ok) throw new Error("expected a failure");
    expect(r.error.message).toContain("already exists");
  });

  it("correlates by id, not by position", async () => {
    const { svc } = makeService({
      respond: () => ({
        responses: [
          { id: "b", status: 500, body: { error: { message: "boom" } } },
          { id: "a", status: 200, body: { ok: 1 } },
        ],
      }),
    });
    const [a, b] = await svc.execute([req("a"), req("b")]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
  });

  it("surfaces a missing sub-response as a failure for that request", async () => {
    const { svc } = makeService({
      respond: () => ({ responses: [{ id: "a", status: 200, body: {} }] }),
    });
    const [, b] = await svc.execute([req("a"), req("b")]);
    if (b.ok) throw new Error("expected a failure");
    expect(b.error.message).toContain('no response for request id "b"');
  });
});

describe("BatchService — unsupported-server detection and fallback signalling", () => {
  // A server or gateway that does not know the endpoint may answer with any of
  // these; all of them must reach the caller's fallback rather than fail the
  // whole bulk operation.
  for (const status of [400, 403, 404, 405, 500, 501]) {
    it(`maps HTTP ${status} on the $batch endpoint to BatchUnsupportedError`, async () => {
      const { svc } = makeService({
        throwOnBatch: new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: "no such endpoint",
          httpStatus: status,
        }),
      });
      await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
        BatchUnsupportedError,
      );
      expect(svc.isKnownUnsupported).toBe(true);
    });
  }

  it("treats a 200 that is not a batch envelope as unsupported", async () => {
    const { svc } = makeService({
      respond: () => ({ value: "some proxy page" }),
    });
    await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(svc.isKnownUnsupported).toBe(true);
  });

  it("remembers the verdict — no second probe on the same connection", async () => {
    const { svc, sent } = makeService({ respond: () => ({ nope: true }) });
    await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    await expect(svc.execute([req("b")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(sent).toHaveLength(1);
  });

  it.each([
    ["AUTH_FAILED", TM1ErrorCode.AUTH_FAILED],
    ["CONNECTION_FAILED", TM1ErrorCode.CONNECTION_FAILED],
    ["LOCK_TIMEOUT", TM1ErrorCode.LOCK_TIMEOUT],
  ])(
    "propagates systemic %s instead of calling it unsupported",
    async (_label, code) => {
      // Critical: a network blip must NOT be read as "no $batch here", or the
      // caller's fallback would silently re-drive every write.
      const boom = new TM1Error({ code, message: "transport down" });
      const { svc } = makeService({ throwOnBatch: boom });
      await expect(svc.execute([req("a")])).rejects.toBe(boom);
      expect(svc.isKnownUnsupported).toBe(false);
    },
  );

  it("propagates a non-systemic, non-unsupported error unchanged", async () => {
    const boom = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: "teapot",
      httpStatus: 418,
    });
    const { svc } = makeService({ throwOnBatch: boom });
    await expect(svc.execute([req("a")])).rejects.toBe(boom);
    expect(svc.isKnownUnsupported).toBe(false);
  });

  // Once $batch has demonstrably worked, "unsupported" is no longer a possible
  // explanation — and the caller's fallback would replay writes that are already
  // committed. Everything after the first success therefore propagates.
  it("never declares unsupported after a batch has already succeeded", async () => {
    let call = 0;
    const http = {
      async request<T>(_m: string, _p: string, body?: unknown): Promise<T> {
        call++;
        if (call === 1) {
          const payload = body as { requests: Array<Record<string, unknown>> };
          return {
            responses: payload.requests.map((r) => ({
              id: r.id,
              status: 200,
              body: {},
            })),
          } as T;
        }
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "gateway hiccup",
          httpStatus: 400,
        });
      },
    } as unknown as TM1HttpClient;
    const svc = new BatchService(http);

    await svc.execute([req("a")]);
    const err = await svc.execute([req("b")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TM1Error);
    expect(err).not.toBeInstanceOf(BatchUnsupportedError);
    expect(svc.isKnownUnsupported).toBe(false);
  });

  it("does NOT counter-probe the unambiguous statuses", async () => {
    // 404/405/501 are verdicts about the URL and the METHOD, both of which are
    // constants here; 403 is a verdict about the caller's identity; 500 keeps
    // the fallback because it can arrive mid-commit. None of them can be
    // explained by "the payload was bad", so a probe could not change the
    // answer — and must not cost a round-trip.
    for (const status of [403, 404, 405, 500, 501]) {
      const { svc, sent } = makeService({
        throwOnBatch: new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: "no such endpoint",
          httpStatus: status,
        }),
      });
      await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
        BatchUnsupportedError,
      );
      expect(svc.isKnownUnsupported).toBe(true);
      expect(sent.filter(isProbe)).toHaveLength(0);
      expect(sent).toHaveLength(1);
    }
  });

  it("treats a non-envelope 200 after a successful batch as a hard error", async () => {
    let call = 0;
    const http = {
      async request<T>(_m: string, _p: string, body?: unknown): Promise<T> {
        call++;
        if (call === 1) {
          const payload = body as { requests: Array<Record<string, unknown>> };
          return {
            responses: payload.requests.map((r) => ({
              id: r.id,
              status: 200,
              body: {},
            })),
          } as T;
        }
        return { value: "some proxy page" } as T;
      },
    } as unknown as TM1HttpClient;
    const svc = new BatchService(http);

    await svc.execute([req("a")]);
    const err = await svc.execute([req("b")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TM1Error);
    expect(err).not.toBeInstanceOf(BatchUnsupportedError);
    expect(svc.isKnownUnsupported).toBe(false);
  });
});

// A 400 on POST /$batch has two incompatible causes, and before the first
// success the service cannot tell them apart from the status alone:
//   (a) a router/gateway that does not know the endpoint and answers
//       "invalid URL" 400 -> $batch is genuinely unusable, fall back;
//   (b) TM1 refusing THIS envelope (duplicate sub-request ids, atomicityGroup,
//       a body over a proxy limit) -> $batch works fine, the payload was bad.
// Reading every first-call 400 as (a) pins the connection to "no $batch" for
// the rest of the session, and every later bulk write then silently takes the
// N-times-slower per-request path — a wrong verdict that is never revisited.
// The counter-probe settles it with one minimal, side-effect-free envelope.
describe("BatchService — counter-probe on an ambiguous first-call 400", () => {
  it("propagates the real error and keeps the connection usable when the probe succeeds", async () => {
    const boom = payload400();
    let realCalls = 0;
    const { svc, sent } = makeService({
      respond: (payload) => {
        if (isProbePayload(payload)) return probeEnvelope();
        realCalls++;
        if (realCalls === 1) throw boom;
        return echoEnvelope(payload);
      },
    });

    // The caller's own error comes back verbatim — NOT BatchUnsupportedError,
    // so the caller does not restart its writes on the per-request path.
    const err = await svc.execute([req("a")]).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(BatchUnsupportedError);
    expect(svc.isKnownUnsupported).toBe(false);

    // The probe is one bodyless GET of the same reachability read the v11 login
    // uses, addressed service-root-relative so it also works against a v12
    // database root.
    const probes = sent.filter(isProbe);
    expect(probes).toHaveLength(1);
    expect(probes[0].path).toBe("/api/v1/$batch");
    expect((probes[0].body as Payload).requests).toEqual([
      {
        id: BATCH_PROBE_ID,
        method: "GET",
        url: "Configuration/ProductVersion",
      },
    ]);

    // And the verdict stuck: the next batch goes out over $batch as normal,
    // with no second probe.
    const results = await svc.execute([req("b"), req("c")]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results.map((r) => r.id)).toEqual(["b", "c"]);
    expect(sent.filter(isProbe)).toHaveLength(1);
  });

  it("still reports the caller's writes as unsupported when the probe also fails", async () => {
    // Nothing here can serve $batch — the minimal envelope is refused too.
    const { svc, sent } = makeService({
      respond: () => {
        throw payload400();
      },
    });

    await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(svc.isKnownUnsupported).toBe(true);
    expect(sent.filter(isProbe)).toHaveLength(1);
    // And the remembered verdict short-circuits the next call with no HTTP.
    await expect(svc.execute([req("b")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(sent).toHaveLength(2);
  });

  it("probes AT MOST ONCE per connection, even across several failing calls", async () => {
    // The probe dies systemically, so no verdict can be drawn from it and
    // `supported` stays undecided. The next 400 must NOT probe again — one
    // failed bulk operation may never turn into a probe storm.
    const down = new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: "transport down",
    });
    const { svc, sent } = makeService({
      respond: (payload) => {
        if (isProbePayload(payload)) throw down;
        throw payload400();
      },
    });

    await expect(svc.execute([req("a")])).rejects.toBe(down);
    // Second call: 400 again, but the probe is spent -> today's behaviour.
    await expect(svc.execute([req("b")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    await expect(svc.execute([req("c")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(sent.filter(isProbe)).toHaveLength(1);
    // real #1, probe, real #2 — the third call short-circuits on the verdict.
    expect(sent).toHaveLength(3);
  });

  it("does not probe at all for a 400 AFTER a batch has already succeeded", async () => {
    // Once $batch has demonstrably worked, "unsupported" is not a candidate
    // explanation any more, so there is nothing to counter-probe.
    const boom = payload400();
    let realCalls = 0;
    const { svc, sent } = makeService({
      respond: (payload) => {
        if (isProbePayload(payload)) return probeEnvelope();
        realCalls++;
        if (realCalls === 1) return echoEnvelope(payload);
        throw boom;
      },
    });

    await svc.execute([req("a")]);
    await expect(svc.execute([req("b")])).rejects.toBe(boom);
    expect(svc.isKnownUnsupported).toBe(false);
    expect(sent.filter(isProbe)).toHaveLength(0);
    expect(sent).toHaveLength(2);
  });

  it("surfaces a systemic probe failure and leaves the verdict undecided", async () => {
    // A network blip during the probe proves nothing about $batch. It must not
    // be read as "unsupported" (the caller would silently re-drive every write),
    // and it must not be read as "supported" either.
    for (const code of [
      TM1ErrorCode.AUTH_FAILED,
      TM1ErrorCode.CONNECTION_FAILED,
      TM1ErrorCode.LOCK_TIMEOUT,
    ]) {
      const down = new TM1Error({ code, message: "probe blew up" });
      const { svc } = makeService({
        respond: (payload) => {
          if (isProbePayload(payload)) throw down;
          throw payload400();
        },
      });
      const err = await svc.execute([req("a")]).catch((e: unknown) => e);
      expect(err).toBe(down);
      expect(err).not.toBeInstanceOf(BatchUnsupportedError);
      // Undecided, not false: `isKnownUnsupported` stays false AND a later
      // successful batch is still possible on this connection.
      expect(svc.isKnownUnsupported).toBe(false);
    }
  });

  it("counts a 200 non-envelope probe response as unsupported", async () => {
    // A proxy page answering 200 on $batch is a look-alike endpoint, not a
    // working one — the probe judges the ENVELOPE, exactly as executeChunk does.
    const { svc, sent } = makeService({
      respond: (payload) => {
        if (isProbePayload(payload)) return { value: "some proxy page" };
        throw payload400();
      },
    });
    await expect(svc.execute([req("a")])).rejects.toBeInstanceOf(
      BatchUnsupportedError,
    );
    expect(svc.isKnownUnsupported).toBe(true);
    expect(sent.filter(isProbe)).toHaveLength(1);
  });

  it("treats a failing probe SUB-request as proof that $batch works", async () => {
    // The probe asks whether the ENVELOPE is served, not whether the caller may
    // read Configuration. A 403/404 inside a well-formed responses array still
    // means $batch itself is alive — otherwise a locked-down account would be
    // misdiagnosed as a server without $batch.
    const boom = payload400();
    const { svc } = makeService({
      respond: (payload) => {
        if (isProbePayload(payload)) {
          return {
            responses: [
              {
                id: BATCH_PROBE_ID,
                status: 403,
                body: { error: { message: "no rights" } },
              },
            ],
          };
        }
        throw boom;
      },
    });
    await expect(svc.execute([req("a")])).rejects.toBe(boom);
    expect(svc.isKnownUnsupported).toBe(false);
  });
});
