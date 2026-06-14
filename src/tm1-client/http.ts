// HTTP transport layer for TM1Client. Owns request/response, retry, auth-retry,
// and TM1-specific error classification. Domain methods live in tm1-client.ts.
import type pino from "pino";
import type { TM1Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import { NAME, VERSION } from "../version.js";
import { getTm1Dispatcher, tm1Fetch } from "./dispatcher.js";
// Side-effect import: registers tm1Events mutation listener in tm1-adapter.
import "../lib/callgraph/tm1-adapter.js";
import { tm1Events } from "../lib/tm1-events.js";

const MAX_NETWORK_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const USER_AGENT = `${NAME}/${VERSION}`;

// R2-22: any successful mutating HTTP call invalidates the callgraph
// reference-index cache. Cheap (Map.clear()) and rebuild is lazy on next
// read — over-invalidation on non-graph-affecting calls (write_cells,
// upload_file, CheckRules) costs at most one rebuild. The alternative —
// per-service hooks across 17 mutation methods — risks drift as new
// mutating methods are added.
function isSafeHttpMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

// Per-call overrides for the global config defaults. timeoutMs caps long-running
// execute_mdx/process/chore; signal forwards an MCP-side AbortSignal (R2-03) so
// `notifications/cancelled` from a client terminates the in-flight fetch.
export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  // Disable the safe-method network-retry loop for this call. Use for
  // deterministically-slow endpoints (e.g. the transaction log) where a
  // timeout means "too much data", not a transient blip — retrying just
  // multiplies the wait. Default: retries enabled for safe methods.
  retry?: boolean;
}

// Link an external AbortSignal (e.g. from RequestHandlerExtra.signal) to a
// locally-owned timeout AbortController. Returns an unsubscribe function the
// caller must invoke in `finally` to avoid leaking the listener after the
// request resolves. If the external signal is already aborted, propagates the
// reason immediately.
function linkAbortSignals(local: AbortController, external?: AbortSignal): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    local.abort(external.reason);
    return () => undefined;
  }
  const onAbort = (): void => local.abort(external.reason);
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

export class TM1HttpClient {
  // Public so domain Service classes (CubeService, ProcessService, ...) can
  // read tm1Version for version-conditional code paths and emit structured
  // logs without holding their own logger refs.
  public readonly config: TM1Config;
  public readonly logger: pino.Logger;
  protected readonly sessionManager: SessionManager;

  constructor(
    config: TM1Config,
    sessionManager: SessionManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
  }

  /**
   * Make an authenticated HTTP request to the TM1 REST API.
   *
   * - Ensures an active session via SessionManager
   * - On 401: re-authenticates once and retries
   * - On network error for safe methods (GET/HEAD): retries up to 3 times with exponential backoff (1s, 2s, 4s)
   * - On network error for non-safe methods (POST/PUT/PATCH/DELETE): does NOT retry — these are not idempotent
   *   and a retry could spawn duplicate side-effects (e.g. parallel TI runs on tm1.Execute)
   * - On other HTTP errors: classifies and throws TM1Error
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const isSafeMethod = isSafeHttpMethod(method);
    const allowRetry = opts?.retry !== false;
    const maxAttempts = isSafeMethod && allowRetry ? MAX_NETWORK_RETRIES : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          { attempt, delayMs, endpoint: path },
          "Retrying after network error",
        );
        await sleep(delayMs);
      }

      try {
        const cookie = await this.sessionManager.ensureSession();
        const response = await this.executeRequest(url, method, cookie, body, opts?.timeoutMs, opts?.signal);

        if (response.status === 401) {
          this.logger.warn({ endpoint: path }, "Received 401, re-authenticating");
          const newCookie = await this.sessionManager.authenticate();
          const retryResponse = await this.executeRequest(
            url,
            method,
            newCookie,
            body,
            opts?.timeoutMs,
            opts?.signal,
          );

          if (retryResponse.status === 401) {
            throw new TM1Error({
              code: TM1ErrorCode.AUTH_FAILED,
              message: "Authentication failed after re-authentication attempt",
              httpStatus: 401,
              endpoint: path,
            });
          }

          const retryResult = await this.handleResponse<T>(retryResponse, path);
          if (!isSafeMethod) {
            tm1Events.emit("mutation", { method, path });
          }
          return retryResult;
        }

        const result = await this.handleResponse<T>(response, path);
        if (!isSafeMethod) {
          tm1Events.emit("mutation", { method, path });
        }
        return result;
      } catch (error) {
        if (error instanceof TM1Error) {
          throw error;
        }

        if (isTimeoutError(error)) {
          const ms = opts?.timeoutMs ?? this.config.requestTimeoutMs;
          throw new TM1Error({
            code: TM1ErrorCode.LOCK_TIMEOUT,
            message: `Request to ${path} timed out after ${ms}ms`,
            endpoint: path,
            hint: isSafeMethod
              ? "Query timed out — result set may be too large. Add filters or reduce scope. If a lock is suspected, use tm1_list_threads to diagnose."
              : "Request timed out — TM1 server may be waiting on a lock held by another session. Use tm1_list_threads to diagnose and cancel the blocking thread.",
          });
        }

        if (opts?.signal?.aborted) {
          throw error;
        }

        if (this.isNetworkError(error)) {
          lastError = error;
          this.logger.error(
            { err: error, attempt, endpoint: path },
            "Network error during request",
          );
          continue;
        }

        throw new TM1Error({
          code: TM1ErrorCode.CONNECTION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          endpoint: path,
        });
      }
    }

    throw new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: isSafeMethod
        ? `Request failed after ${MAX_NETWORK_RETRIES} retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `Request failed (no retry for ${method}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      endpoint: path,
    });
  }

  /**
   * Make an authenticated HTTP request that returns raw text (not JSON).
   * Used for file content downloads where the response is CSV/TXT/etc.
   * Re-auths once on 401 like request().
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async requestRaw(method: string, path: string, opts?: RequestOptions): Promise<string> {
    const url = `${this.config.baseUrl}${path}`;
    const effectiveTimeout = opts?.timeoutMs ?? this.config.requestTimeoutMs;
    const cookie = await this.sessionManager.ensureSession();

    const headers: Record<string, string> = {
      Cookie: `TM1SessionId=${cookie}`,
      Accept: "*/*",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
    };

    const response = await this.withReauth(
      (c) => {
        const hdrs = { ...headers, Cookie: `TM1SessionId=${c}` };
        return this.sendOnce(url, method, hdrs, undefined, effectiveTimeout, opts?.signal);
      },
      cookie,
      path,
      effectiveTimeout,
    );

    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* ignore */ }
      throw this.classifyHttpError(response.status, path, body || undefined);
    }
    const text = await response.text();
    if (!isSafeHttpMethod(method)) {
      tm1Events.emit("mutation", { method, path });
    }
    return text;
  }

  /**
   * Make an authenticated HTTP request with a binary body (Buffer/Uint8Array).
   * Used for blob/file uploads where the body is raw bytes (not JSON).
   * Sends Content-Type: application/octet-stream by default.
   * Re-auths once on 401 like request(). No network-error retries (non-safe methods).
   */
  /** @internal — for Service-layer use; not part of the public consumer API. */
  public async requestBinary(
    method: string,
    path: string,
    body: Uint8Array,
    contentType: string = "application/octet-stream",
    opts?: RequestOptions,
  ): Promise<void> {
    const url = `${this.config.baseUrl}${path}`;
    const effectiveTimeout = opts?.timeoutMs ?? this.config.requestTimeoutMs;
    const cookie = await this.sessionManager.ensureSession();

    const response = await this.withReauth(
      (c) => this.sendOnce(
        url,
        method,
        {
          Cookie: `TM1SessionId=${c}`,
          Accept: "application/json,*/*",
          "Content-Type": contentType,
          "User-Agent": USER_AGENT,
          "TM1-SessionContext": USER_AGENT,
          "TM1-Session-Context": USER_AGENT,
        },
        body,
        effectiveTimeout,
        opts?.signal,
      ),
      cookie,
      path,
      effectiveTimeout,
    );

    if (!response.ok) {
      let errBody = "";
      try { errBody = await response.text(); } catch { /* ignore */ }
      throw this.classifyHttpError(response.status, path, errBody || undefined);
    }
    if (!isSafeHttpMethod(method)) {
      tm1Events.emit("mutation", { method, path });
    }
  }

  /**
   * Low-level single fetch with timeout + AbortSignal wiring.
   * Does NOT handle 401, retries, or error classification — callers own that.
   */
  private async sendOnce(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | Uint8Array | undefined,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      timeoutMs,
    );
    const unlink = linkAbortSignals(controller, externalSignal);
    try {
      return await tm1Fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        dispatcher: getTm1Dispatcher(this.config),
      } as unknown as RequestInit);
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  /**
   * Wraps a send function with cookie-refresh-on-401 and timeout→LOCK_TIMEOUT mapping.
   * Used by requestRaw and requestBinary (which have no network-retry loop).
   * On 401: calls sessionManager.authenticate() and retries once with the new cookie.
   * The caller is responsible for obtaining the initial cookie via ensureSession().
   */
  private async withReauth(
    send: (cookie: string) => Promise<Response>,
    initialCookie: string,
    path: string,
    effectiveTimeout: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await send(initialCookie);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new TM1Error({ code: TM1ErrorCode.LOCK_TIMEOUT, message: `Request to ${path} timed out after ${effectiveTimeout}ms`, endpoint: path });
      }
      throw err;
    }
    if (response.status === 401) {
      const newCookie = await this.sessionManager.authenticate();
      try {
        response = await send(newCookie);
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new TM1Error({ code: TM1ErrorCode.LOCK_TIMEOUT, message: `Request to ${path} timed out after ${effectiveTimeout}ms`, endpoint: path });
        }
        throw err;
      }
    }
    return response;
  }

  private async executeRequest(
    url: string,
    method: string,
    cookie: string,
    body?: unknown,
    timeoutMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Cookie: `TM1SessionId=${cookie}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
    };

    const isWriteMethod = method === "POST" || method === "PUT" || method === "PATCH";
    if (body !== undefined || isWriteMethod) {
      headers["Content-Type"] = "application/json";
    }

    const serializedBody: string | undefined =
      body !== undefined ? JSON.stringify(body) : isWriteMethod ? "" : undefined;

    return this.sendOnce(url, method, headers, serializedBody, timeoutMs ?? this.config.requestTimeoutMs, externalSignal);
  }


  private async handleResponse<T>(
    response: Response,
    endpoint: string,
  ): Promise<T> {
    if (response.ok) {
      const text = await response.text();
      if (response.status === 204 || !text) {
        return undefined as T;
      }
      this.logger.debug(
        { endpoint, status: response.status },
        "Request successful",
      );
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message:
            `TM1 returned a non-JSON response body (status ${response.status}) for ${endpoint}. ` +
            `This usually means a proxy or gateway returned HTML/text instead of the TM1 REST API.`,
          httpStatus: response.status,
          endpoint,
        });
      }
    }

    let details: string | undefined;
    let errorBody: string;
    try {
      errorBody = await response.text();
      if (errorBody) {
        const parsed = JSON.parse(errorBody);
        details = parsed?.error?.message?.value ?? parsed?.error?.message ?? errorBody;
      }
    } catch {
      /* ignore parse errors */
    }

    const error = this.classifyHttpError(response.status, endpoint, details);
    this.logger.error(
      { endpoint, status: response.status, code: error.code },
      error.message,
    );
    throw error;
  }

  private classifyHttpError(
    status: number,
    endpoint: string,
    details?: string,
  ): TM1Error {
    // TM1 signals object-level security denial via the error MESSAGE, often
    // with HTTP 400 (not 403) — e.g. reading a control cube as a non-admin
    // returns 400 {"error":{"code":"65","message":"ObjectSecurityNoReadRights"}}.
    // Classify by message so the caller gets PERMISSION_DENIED + its actionable
    // hint instead of a generic TM1_ERROR. Verified live with a cube-only user.
    if (details && /No(Read|Write|Admin)Rights|ObjectSecurity|SecurityAccess|not\s+authori[sz]ed/i.test(details)) {
      return new TM1Error({
        code: TM1ErrorCode.PERMISSION_DENIED,
        message: details,
        httpStatus: status,
        endpoint,
        details,
      });
    }
    switch (status) {
      case 401:
        return new TM1Error({
          code: TM1ErrorCode.AUTH_FAILED,
          message: details ?? "Authentication failed",
          httpStatus: status,
          endpoint,
          details,
        });
      case 403:
        return new TM1Error({
          code: TM1ErrorCode.PERMISSION_DENIED,
          message: details ?? "Permission denied",
          httpStatus: status,
          endpoint,
          details,
        });
      case 404:
        return new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: details ?? "Resource not found",
          httpStatus: status,
          endpoint,
          details,
        });
      case 409:
        return new TM1Error({
          code: TM1ErrorCode.CONFLICT,
          message: details ?? "Resource conflict",
          httpStatus: status,
          endpoint,
          details,
        });
      default:
        return new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: details ?? `TM1 API error (HTTP ${status})`,
          httpStatus: status,
          endpoint,
          details,
        });
    }
  }

  private isNetworkError(error: unknown): boolean {
    // TimeoutError is our own request timeout — handled separately as LOCK_TIMEOUT,
    // never treated as a retryable network blip.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return false;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return true;
    }
    if (error instanceof TypeError) {
      return true;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("fetch failed") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout") ||
        msg.includes("network")
      );
    }
    return false;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
