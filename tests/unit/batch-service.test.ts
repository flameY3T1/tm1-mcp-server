import { describe, it, expect } from "vitest";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import {
  BATCH_MAX_REQUESTS,
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
  throwOnBatch?: unknown;
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
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.path).toBe("/api/v1/$batch");
    const payload = sent[0]!.body as {
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
    const payload = sent[0]!.body as {
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
    expect(sent[0]!.opts).toEqual({ timeoutMs: 30_000 + 2 * 200 });
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
    const failed = results[1]!;
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
    if (notFound!.ok || conflict!.ok || denied!.ok)
      throw new Error("expected failures");
    expect(notFound!.error.code).toBe(TM1ErrorCode.NOT_FOUND);
    expect(conflict!.error.code).toBe(TM1ErrorCode.CONFLICT);
    expect(denied!.error.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
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
    if (r!.ok) throw new Error("expected a failure");
    expect(r!.error.message).toBe("deep text");
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
    if (r!.ok) throw new Error("expected a failure");
    expect(r!.error.message).toContain("already exists");
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
    expect(a!.ok).toBe(true);
    expect(b!.ok).toBe(false);
  });

  it("surfaces a missing sub-response as a failure for that request", async () => {
    const { svc } = makeService({
      respond: () => ({ responses: [{ id: "a", status: 200, body: {} }] }),
    });
    const [, b] = await svc.execute([req("a"), req("b")]);
    if (b!.ok) throw new Error("expected a failure");
    expect(b!.error.message).toContain('no response for request id "b"');
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
