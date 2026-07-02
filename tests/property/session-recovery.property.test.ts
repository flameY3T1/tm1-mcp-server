/**
 * Feature: tm1-mcp-server, Property 3: Session-Wiederherstellung bei 401
 *
 * For every API call that returns HTTP 401, the TM1 Client automatically
 * re-authenticates and retries the original call.
 *
 * **Validates: Requirements 1.6, 7.3**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1HttpClient } from "../../src/tm1-client/http.js";
import { SessionManager } from "../../src/session-manager.js";
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
    keepAliveIntervalMs: 60000, requestTimeoutMs: 30000, logLevel: "info",
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
    ok: opts.ok ?? true, status: opts.status ?? 200,
    statusText: opts.status === 401 ? "Unauthorized" : "OK",
    headers: new Headers(),
    text: vi.fn().mockResolvedValue(bodyText),
    json: vi.fn().mockResolvedValue(opts.body ?? {}),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

describe("Property 3: Session-Wiederherstellung bei 401", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("on 401, re-authenticates and retries, returning correct result", async () => {
    const endpointArb = fc.constantFrom("/api/v1/Cubes", "/api/v1/Dimensions", "/api/v1/Processes");
    const responseDataArb = fc.record({
      value: fc.array(fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }) }), { minLength: 0, maxLength: 5 }),
    });

    await fc.assert(
      fc.asyncProperty(endpointArb, responseDataArb, async (endpoint, expectedData) => {
        let callCount = 0;
        const localFetch = vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mockResp({ ok: false, status: 401 }));
          return Promise.resolve(mockResp({ ok: true, body: expectedData }));
        });
        globalThis.fetch = localFetch as typeof fetch;

        const config = makeConfig();
        const sm = new SessionManager(config, mockLogger);
        vi.spyOn(sm, "ensureSession").mockResolvedValue("oldSession");
        vi.spyOn(sm, "authenticate").mockResolvedValue("newSession");
        const client = new TestTM1Client(config, sm, mockLogger);

        const result = await client.testRequest("GET", endpoint);
        expect(result).toEqual(expectedData);
        expect(sm.authenticate).toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });
});
