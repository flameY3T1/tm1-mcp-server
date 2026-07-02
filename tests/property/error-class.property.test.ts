/**
 * Feature: tm1-mcp-server, Property 15: API-Fehlerantwort-Struktur
 * Feature: tm1-mcp-server, Property 16: Netzwerkfehler-Klassifizierung
 * Feature: tm1-mcp-server, Property 12: Berechtigungsfehler-Klassifizierung
 *
 * **Validates: Requirements 1.4, 3.4, 9.1** (Property 15)
 * **Validates: Requirements 9.2** (Property 16)
 * **Validates: Requirements 7.4** (Property 12)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";
import type { TM1Config } from "../../src/config.js";

const mockLogger = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  level: "silent", flush: vi.fn(),
} as unknown as import("pino").Logger;

function makeConfig(): TM1Config {
  return {
    baseUrl: "https://tm1server:8010", user: "admin", password: "secret",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info",
  };
}

class TestTM1Client extends TM1HttpClient {
  async testRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body);
  }
}

function mockResp(opts: { ok?: boolean; status?: number; body?: unknown }): Response {
  const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : "";
  return {
    ok: opts.ok ?? true, status: opts.status ?? 200, statusText: "Error",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(opts.body ?? {}),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

describe("Property 15: API-Fehlerantwort-Struktur", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("HTTP errors contain status code, message, and endpoint (all non-empty)", async () => {
    const statusArb = fc.constantFrom(400, 403, 404, 409, 500, 502, 503);
    const endpointArb = fc.constantFrom("/api/v1/Cubes", "/api/v1/Dimensions", "/api/v1/Processes");
    const messageArb = fc.string({ minLength: 1, maxLength: 100 });

    await fc.assert(
      fc.asyncProperty(statusArb, endpointArb, messageArb, async (status, endpoint, message) => {
        const localFetch = vi.fn().mockResolvedValue(
          mockResp({ ok: false, status, body: { error: { message: { value: message } } } }),
        );
        globalThis.fetch = localFetch as typeof fetch;

        const config = makeConfig();
        const sm = new SessionManager(config, mockLogger);
        vi.spyOn(sm, "ensureSession").mockResolvedValue("session123");
        vi.spyOn(sm, "authenticate").mockResolvedValue("newSession");
        const client = new TestTM1Client(config, sm, mockLogger);

        try {
          await client.testRequest("GET", endpoint);
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(TM1Error);
          const err = e as TM1Error;
          expect(err.httpStatus).toBe(status);
          expect(typeof err.message).toBe("string");
          expect(err.message.length).toBeGreaterThan(0);
          expect(typeof err.endpoint).toBe("string");
          expect(err.endpoint!.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 16: Netzwerkfehler-Klassifizierung", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("network errors are classified as CONNECTION_FAILED with reconnection attempt", async () => {
    const networkErrorArb = fc.constantFrom(
      () => new TypeError("fetch failed"),
      () => new TypeError("connect ECONNREFUSED 127.0.0.1:8010"),
      () => new TypeError("getaddrinfo ENOTFOUND tm1server"),
      // NB: a bare AbortError is intentionally excluded — it signals caller
      // cancellation, is not retried, and is covered in http-abort-signal.test.ts.
    );
    const endpointArb = fc.constantFrom("/api/v1/Cubes", "/api/v1/Dimensions");

    await fc.assert(
      fc.asyncProperty(networkErrorArb, endpointArb, async (errorFactory, endpoint) => {
        const localFetch = vi.fn().mockRejectedValue(errorFactory());
        globalThis.fetch = localFetch as typeof fetch;

        const config = makeConfig();
        const sm = new SessionManager(config, mockLogger);
        vi.spyOn(sm, "ensureSession").mockResolvedValue("session123");
        vi.spyOn(sm, "authenticate").mockResolvedValue("newSession");
        const client = new TestTM1Client(config, sm, mockLogger);

        try {
          await client.testRequest("GET", endpoint);
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(TM1Error);
          const err = e as TM1Error;
          expect(err.code).toBe(TM1ErrorCode.CONNECTION_FAILED);
          expect(err.endpoint).toBe(endpoint);
        }
        // initial + 3 retries = 4 calls
        expect(localFetch.mock.calls.length).toBe(4);
      }),
      { numRuns: 4 },
    );
  }, 60000);
});

describe("Property 12: Berechtigungsfehler-Klassifizierung", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("HTTP 403 responses produce PERMISSION_DENIED with extracted permission message", async () => {
    const permMsgArb = fc.constantFrom(
      "Insufficient privileges to read cube data",
      "User does not have READ access to dimension",
      "WRITE permission required for this operation",
      "Access denied for security group",
      "No permission to execute process",
    );
    const endpointArb = fc.constantFrom("/api/v1/Cubes", "/api/v1/Dimensions", "/api/v1/Processes");

    await fc.assert(
      fc.asyncProperty(permMsgArb, endpointArb, async (permMessage, endpoint) => {
        const localFetch = vi.fn().mockResolvedValue(
          mockResp({ ok: false, status: 403, body: { error: { message: { value: permMessage } } } }),
        );
        globalThis.fetch = localFetch as typeof fetch;

        const config = makeConfig();
        const sm = new SessionManager(config, mockLogger);
        vi.spyOn(sm, "ensureSession").mockResolvedValue("session123");
        vi.spyOn(sm, "authenticate").mockResolvedValue("newSession");
        const client = new TestTM1Client(config, sm, mockLogger);

        try {
          await client.testRequest("GET", endpoint);
          expect.unreachable("Should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(TM1Error);
          const err = e as TM1Error;
          expect(err.code).toBe(TM1ErrorCode.PERMISSION_DENIED);
          expect(err.httpStatus).toBe(403);
          expect(err.details).toBe(permMessage);
          expect(err.endpoint).toBe(endpoint);
        }
      }),
      { numRuns: 100 },
    );
  });
});
