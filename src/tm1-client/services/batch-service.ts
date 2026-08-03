// Batch domain service. Owns the one OData endpoint that is not tied to a TM1
// object type: POST /api/v1/$batch. It folds many independent REST calls into a
// single HTTP round-trip and hands each sub-response back to the caller
// separately.
//
// Verified live (TM1 v11 11.8.02900.8 and v12 / PA Engine 12.5.9):
//   - Only the OData 4.01 **JSON** batch format is accepted. A multipart/mixed
//     body is rejected with 400 "No acceptable mime type specified. $batch
//     produces application/json responses!".
//   - The batch is NOT atomic. `atomicityGroup` is refused outright: 400
//     "$batch implementation DOES NOT support atomicity groups, hence the
//     'atomicityGroup' property MUST NOT be defined".
//   - Continue-on-error is the DEFAULT: with [ok, fail, ok] all three run and
//     both successes are committed; a leading failure does not stop the rest.
//   - The envelope is HTTP 200 even when sub-requests fail; each entry carries
//     its own `status` and error `body`.
//
// That combination is what makes this safe for the bulk paths: partial success
// is the server's native behaviour, so per-item success/failure reporting is
// preserved rather than collapsed into one all-or-nothing result.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { classifyHttpError } from "../http.js";
import type { TM1HttpClient } from "../http.js";
import { rethrowIfSystemic } from "./fallback.js";

const BATCH_PATH = "/api/v1/$batch";

// Sub-requests per HTTP round-trip. TM1 accepts far larger batches (5000
// element creates succeeded live) but processes them SEQUENTIALLY server-side,
// so a huge batch just builds one very long request: 5000 creates took ~47s,
// well past a normal 30s request timeout, and a timeout mid-batch leaves an
// unknown amount committed. Chunking keeps each round-trip bounded and gives
// natural progress boundaries, while still collapsing ~200 calls into one.
export const BATCH_MAX_REQUESTS = 200;

// A batch performs N operations in one HTTP call, so the per-call default
// timeout is the wrong budget for it. Scale with the chunk size instead.
const BATCH_TIMEOUT_BASE_MS = 30_000;
const BATCH_TIMEOUT_PER_REQUEST_MS = 200;

export interface BatchRequest {
  /** Caller-chosen correlation id. Must be unique within one execute() call. */
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Same `/api/v1/...` form the other services use; rerooted for v12 by the profile. */
  path: string;
  body?: unknown;
}

export type BatchSubResult =
  | { id: string; status: number; ok: true; body: unknown }
  | { id: string; status: number; ok: false; error: TM1Error };

/**
 * Thrown when the server cannot serve `$batch` at all (endpoint absent, method
 * refused, or an envelope we cannot read). Distinct from a sub-request failure,
 * which is reported per item. Callers catch ONLY this to fall back to their
 * per-request path — never a sub-request error, and never a systemic
 * transport/auth failure (those propagate).
 *
 * GUARANTEE for those callers: this is raised only before the first successful
 * batch on the connection — i.e. only ever out of the caller's FIRST pass.
 *
 * What that does NOT mean: "nothing was committed". TM1's `$batch` is
 * non-atomic (verified live against 11.8: a failing sub-request leaves its
 * siblings in the same envelope committed), and an ambiguous status such as 500
 * can arrive after the server already applied part of the envelope. A caller
 * that restarts per-request MAY therefore re-issue writes that already took
 * effect.
 *
 * The requirement on callers is therefore: THE FIRST PASS MUST BE REPLAY-SAFE.
 * `ElementService.bulkUpsert` satisfies this because its first pass is
 * create-only, and re-creating an existing element degrades to the upsert path.
 * A future caller whose first pass mutates existing state must NOT rely on this
 * error to fall back. See `BatchService.markUnsupported`.
 */
export class BatchUnsupportedError extends Error {
  constructor(reason: string) {
    super(`TM1 $batch is not usable on this server: ${reason}`);
    this.name = "BatchUnsupportedError";
  }
}

// Statuses that can mean "this server has no usable $batch endpoint". The
// obvious ones are 501 Not Implemented / 405 Method Not Allowed / 404 Not Found,
// but a server or gateway that does not know the endpoint may just as well
// answer 400 ("invalid URL"), 403, or 500 — and every one of those would
// otherwise fail the whole bulk operation instead of falling back to the
// caller's per-request path.
//
// Read this set ONLY together with `markUnsupported`: a status here counts as
// "unsupported" exclusively before the first successful batch on this
// connection. Once `$batch` has demonstrably worked, a 400 means "your payload
// was bad" and must propagate rather than silently re-drive the caller's writes.
const UNSUPPORTED_STATUSES = new Set([400, 403, 404, 405, 500, 501]);

interface RawSubResponse {
  id?: unknown;
  status?: unknown;
  body?: unknown;
}

/**
 * Pull TM1's human-readable error text out of a sub-response body.
 *
 * Mirrors `handleResponse`'s extraction in http.ts — INCLUDING its final
 * raw-body fallback. That fallback is load-bearing, not cosmetic: callers
 * classify by message text (e.g. `isAlreadyExists` substring-matches
 * "already exists"), so returning `undefined` for a body that does not nest
 * under `error.message` would downgrade a recognisable error into a generic
 * "TM1 API error (HTTP 400)" and break bulk upsert's idempotency.
 */
function extractErrorDetails(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body || undefined;
  if (typeof body !== "object") return String(body);
  const err = (body as { error?: unknown }).error;
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (message !== null && typeof message === "object") {
      const value = (message as { value?: unknown }).value;
      if (typeof value === "string") return value;
    }
  }
  // Unrecognised shape — hand back the raw body text, as http.ts does.
  try {
    return JSON.stringify(body) || undefined;
  } catch {
    return undefined;
  }
}

function toRelativeUrl(path: string): string {
  return path.replace(/^\/api\/v1\//, "");
}

export class BatchService {
  // Tri-state support verdict, remembered for the lifetime of the client so a
  // server without $batch is probed once, not once per bulk operation.
  private supported: boolean | null = null;

  constructor(private readonly http: TM1HttpClient) {}

  /** True once a probe has established the server rejects `$batch` outright. */
  get isKnownUnsupported(): boolean {
    return this.supported === false;
  }

  /**
   * Record a "this server has no usable `$batch`" verdict — but ONLY while no
   * batch has ever succeeded on this connection.
   *
   * That precondition is the whole safety argument for the caller's fallback.
   * `BatchUnsupportedError` makes callers restart their operation on the
   * per-request path. While `supported === null` no chunk has ever come back
   * 200, so the failure can only be in the caller's FIRST pass. Note what that
   * bounds: WHICH writes may be replayed, not WHETHER anything was committed —
   * `$batch` is non-atomic, so sub-requests processed before the failure stay
   * committed. Callers must keep that first pass replay-safe.
   *
   * Once `supported === true`, a later failure — a flaky gateway answering
   * chunk 2 with HTML or a 400 — is a real error and is propagated verbatim, so
   * a half-finished batch is never silently replayed. That is what keeps the
   * destructive later passes (type PATCH, Components) out of the fallback
   * window entirely: they only ever run after a batch has already succeeded.
   *
   * Returns the error to throw, or `undefined` when the verdict was refused.
   */
  private markUnsupported(reason: string): BatchUnsupportedError | undefined {
    if (this.supported !== null) return undefined;
    this.supported = false;
    return new BatchUnsupportedError(reason);
  }

  /**
   * Run `requests` in as few round-trips as possible and return one result per
   * request, in the order given.
   *
   * A failing sub-request is DATA, not an exception: it comes back as
   * `{ok:false, error}` so the caller can report partial success. Only a
   * whole-envelope failure throws — `BatchUnsupportedError` if the server has no
   * `$batch`, or the underlying TM1Error for a transport/auth/timeout failure.
   *
   * POST /api/v1/$batch
   */
  async execute(requests: BatchRequest[]): Promise<BatchSubResult[]> {
    if (requests.length === 0) return [];
    if (this.supported === false) {
      throw new BatchUnsupportedError(
        "a previous probe on this connection was rejected",
      );
    }

    const results: BatchSubResult[] = [];
    for (let i = 0; i < requests.length; i += BATCH_MAX_REQUESTS) {
      const chunk = requests.slice(i, i + BATCH_MAX_REQUESTS);
      results.push(...(await this.executeChunk(chunk)));
    }
    return results;
  }

  private async executeChunk(chunk: BatchRequest[]): Promise<BatchSubResult[]> {
    const payload = {
      requests: chunk.map((r) => ({
        id: r.id,
        method: r.method,
        // Sub-request URLs are relative to the batch endpoint's service root.
        // Callers pass the same absolute `/api/v1/...` path they would give
        // http.request(), so strip that prefix here — for v12 the profile
        // reroots the `$batch` URL itself, and the relative sub-URL rides along.
        url: toRelativeUrl(r.path),
        ...(r.body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: r.body }),
      })),
    };

    let envelope: unknown;
    try {
      envelope = await this.http.request<unknown>("POST", BATCH_PATH, payload, {
        timeoutMs:
          BATCH_TIMEOUT_BASE_MS + chunk.length * BATCH_TIMEOUT_PER_REQUEST_MS,
      });
    } catch (err) {
      // A transport/auth/timeout failure is NOT evidence that $batch is
      // missing. Swallowing it into "unsupported" would silently re-run every
      // write down the fallback path on a network blip.
      rethrowIfSystemic(err);
      if (
        err instanceof TM1Error &&
        err.httpStatus !== undefined &&
        UNSUPPORTED_STATUSES.has(err.httpStatus)
      ) {
        const unsupported = this.markUnsupported(
          `POST ${BATCH_PATH} returned HTTP ${err.httpStatus}`,
        );
        if (unsupported) throw unsupported;
      }
      throw err;
    }

    const responses = (envelope as { responses?: unknown } | null)?.responses;
    if (!Array.isArray(responses)) {
      // 200 but not an OData batch envelope — a proxy or a look-alike endpoint.
      // Treat as unsupported rather than guessing at the shape, but only if
      // $batch never worked here; mid-operation this is a hard error (see
      // markUnsupported).
      const unsupported = this.markUnsupported(
        `response had no "responses" array`,
      );
      if (unsupported) throw unsupported;
      throw new TM1Error({
        code: TM1ErrorCode.TM1_ERROR,
        message: `TM1 $batch returned a 200 response without a "responses" array after $batch had already worked on this connection`,
        endpoint: BATCH_PATH,
      });
    }
    this.supported = true;

    // OData does not promise response order, so correlate by id.
    const byId = new Map<string, RawSubResponse>();
    for (const raw of responses as RawSubResponse[]) {
      if (raw && raw.id !== undefined) byId.set(String(raw.id), raw);
    }

    return chunk.map((req): BatchSubResult => {
      const raw = byId.get(req.id);
      if (!raw) {
        return {
          id: req.id,
          status: 0,
          ok: false,
          error: new TM1Error({
            code: TM1ErrorCode.TM1_ERROR,
            message: `TM1 $batch returned no response for request id "${req.id}"`,
            endpoint: req.path,
          }),
        };
      }
      const status = typeof raw.status === "number" ? raw.status : 0;
      if (status >= 200 && status < 300) {
        return { id: req.id, status, ok: true, body: raw.body };
      }
      return {
        id: req.id,
        status,
        ok: false,
        error: classifyHttpError(
          status,
          req.path,
          extractErrorDetails(raw.body),
        ),
      };
    });
  }
}
