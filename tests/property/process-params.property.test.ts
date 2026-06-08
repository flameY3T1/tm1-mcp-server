/**
 * Feature: tm1-mcp-server, Property 8: Prozessparameter-Roundtrip
 *
 * **Validates: Requirements 4.4, 5.6**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";
import type { ProcessParameter } from "../../src/types.js";

const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: "silent", flush: vi.fn() } as unknown as import("pino").Logger;
function makeConfig(): TM1Config { return { baseUrl: "https://tm1server:8010", user: "admin", password: "secret", ssl: { rejectUnauthorized: true }, keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info" }; }

const originalFetch = globalThis.fetch;

describe("Property 8: Prozessparameter-Roundtrip", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("written parameters are identical to read parameters", async () => {
    const paramArb: fc.Arbitrary<ProcessParameter> = fc.record({
      name: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
      type: fc.constantFrom("String" as const, "Numeric" as const),
      defaultValue: fc.oneof(fc.string({ maxLength: 30 }), fc.integer({ min: -10000, max: 10000 })),
    });

    await fc.assert(fc.asyncProperty(fc.array(paramArb, { minLength: 0, maxLength: 5 }), async (params) => {
      const apiReadResponse = { value: params.map((p) => ({ Name: p.name, Type: p.type, Value: p.defaultValue })) };
      let callIdx = 0;
      const f = vi.fn().mockImplementation((_url: string, opts: { method?: string }) => {
        callIdx++;
        if (opts.method === "PATCH") {
          return Promise.resolve({ ok: true, status: 204, statusText: "No Content", headers: new Headers(), text: vi.fn().mockResolvedValue(""), json: vi.fn().mockRejectedValue(new Error("No content")) } as unknown as Response);
        }
        const t = JSON.stringify(apiReadResponse);
        return Promise.resolve({ ok: true, status: 200, statusText: "OK", headers: new Headers(), text: vi.fn().mockResolvedValue(t), json: vi.fn().mockResolvedValue(apiReadResponse) } as unknown as Response);
      });
      globalThis.fetch = f as typeof fetch;
      const c = makeConfig(); const sm = new SessionManager(c, mockLogger);
      vi.spyOn(sm, "ensureSession").mockResolvedValue("s");
      vi.spyOn(sm, "authenticate").mockResolvedValue("s");
      const client = new TM1Client(c, sm, mockLogger);

      // Write
      await client.processes.updateParameters("TestProcess", params);
      if (params.length > 0) {
        const [, writeOpts] = f.mock.calls[0];
        const writeBody = JSON.parse(writeOpts.body);
        expect(writeBody.Parameters).toHaveLength(params.length);
        for (let i = 0; i < params.length; i++) {
          expect(writeBody.Parameters[i].Name).toBe(params[i].name);
          // OData enum tm1.ProcessVariableType: String=1, Numeric=2.
          const expectNumeric = params[i].type === "Numeric";
          expect(writeBody.Parameters[i].Type).toBe(expectNumeric ? 2 : 1);
          // Value is coerced to the declared type (TM1 v11 classifies from Value).
          const dv = params[i].defaultValue;
          const expectedValue = expectNumeric
            ? (Number.isFinite(Number(dv)) ? Number(dv) : 0)
            : String(dv);
          expect(writeBody.Parameters[i].Value).toBe(expectedValue);
        }
      }

      // Read
      const readParams = await client.processes.getParameters("TestProcess");
      expect(readParams).toHaveLength(params.length);
      for (let i = 0; i < params.length; i++) {
        expect(readParams[i].name).toBe(params[i].name);
        expect(readParams[i].type).toBe(params[i].type);
        expect(readParams[i].defaultValue).toBe(params[i].defaultValue);
      }
    }), { numRuns: 100 });
  });
});
