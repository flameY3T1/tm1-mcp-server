// HTTP transport layer for TM1Client. Owns request/response, retry, auth-retry,
// and TM1-specific error classification. Domain methods live in tm1-client.ts.
import type pino from "pino";
import type { TM1Config } from "../config.js";
import type { SessionManager } from "../session-manager.js";
import { TM1Error, TM1ErrorCode } from "../types.js";
import { NAME, VERSION } from "../version.js";
import { getTm1Dispatcher } from "./dispatcher.js";

const MAX_NETWORK_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const USER_AGENT = `${NAME}/${VERSION}`;

// Per-call overrides for the global config defaults. Currently only carries
// timeoutMs (long-running execute_mdx/process/chore use this); kept as an
// object so future per-call knobs (e.g. abort signal) can be added without
// changing call signatures across the file.
export interface RequestOptions {
  timeoutMs?: number;
}

export class TM1HttpClient {
  protected readonly config: TM1Config;
  protected readonly sessionManager: SessionManager;
  protected readonly logger: pino.Logger;

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
  protected async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: RequestOptions,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const isSafeMethod = method === "GET" || method === "HEAD";
    const maxAttempts = isSafeMethod ? MAX_NETWORK_RETRIES : 0;
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
        const response = await this.executeRequest(url, method, cookie, body, opts?.timeoutMs);

        if (response.status === 401) {
          this.logger.warn({ endpoint: path }, "Received 401, re-authenticating");
          const newCookie = await this.sessionManager.authenticate();
          const retryResponse = await this.executeRequest(
            url,
            method,
            newCookie,
            body,
            opts?.timeoutMs,
          );

          if (retryResponse.status === 401) {
            throw new TM1Error({
              code: TM1ErrorCode.AUTH_FAILED,
              message: "Authentication failed after re-authentication attempt",
              httpStatus: 401,
              endpoint: path,
            });
          }

          return this.handleResponse<T>(retryResponse, path);
        }

        return this.handleResponse<T>(response, path);
      } catch (error) {
        if (error instanceof TM1Error) {
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
  protected async requestRaw(method: string, path: string, opts?: RequestOptions): Promise<string> {
    const url = `${this.config.baseUrl}${path}`;
    const cookie = await this.sessionManager.ensureSession();
    const effectiveTimeout = opts?.timeoutMs ?? this.config.requestTimeoutMs;

    const doFetch = async (c: string): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        return await fetch(url, {
          method,
          headers: {
            Cookie: `TM1SessionId=${c}`,
            Accept: "*/*",
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          signal: controller.signal,
          dispatcher: getTm1Dispatcher(this.config),
        } as RequestInit);
      } finally {
        clearTimeout(timeout);
      }
    };

    let response = await doFetch(cookie);
    if (response.status === 401) {
      const newCookie = await this.sessionManager.authenticate();
      response = await doFetch(newCookie);
    }
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* ignore */ }
      throw this.classifyHttpError(response.status, path, body || undefined);
    }
    return response.text();
  }

  private async executeRequest(
    url: string,
    method: string,
    cookie: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.config.requestTimeoutMs,
    );

    const headers: Record<string, string> = {
      Cookie: `TM1SessionId=${cookie}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
    };

    const isWriteMethod = method === "POST" || method === "PUT" || method === "PATCH";
    if (body !== undefined || isWriteMethod) {
      headers["Content-Type"] = "application/json";
    }

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : isWriteMethod ? "" : undefined,
        signal: controller.signal,
        dispatcher: getTm1Dispatcher(this.config),
      } as RequestInit);
    } finally {
      clearTimeout(timeout);
    }
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
      return JSON.parse(text) as T;
    }

    let details: string | undefined;
    let errorBody = "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
