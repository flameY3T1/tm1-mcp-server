/**
 * Feature: tm1-mcp-server, Property 7: Prozessausführungs-Ergebnis
 *
 * **Validates: Requirements 4.2, 4.3**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: "silent", flush: vi.fn() } as unknown as import("pino").Logger;
function makeConfig(): TM1Config { return { baseUrl: "https://tm1server:8010", user: "admin", password: "secret", ssl: { rejectUnauthorized: true }, keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info" }; }
const originalFetch = globalThis.fetch;
function makeClient(f: ReturnType<typeof vi.fn>) { globalThis.fetch = f as typeof fetch; const c = makeConfig(); const sm = new SessionManager(c, mockLogger); vi.spyOn(sm, "ensureSession").mockResolvedValue("s"); vi.spyOn(sm, "authenticate").mockResolvedValue("s"); return new TM1Client(c, sm, mockLogger); }

describe("Property 7: Prozessausführungs-Ergebnis", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("successful process execution returns success: true with CompletedSuccessfully", async () => {
    await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 30 }), async (processName) => {
      const f = vi.fn().mockResolvedValue({ ok: true, status: 204, statusText: "No Content", headers: new Headers(), text: vi.fn().mockResolvedValue(""), json: vi.fn().mockRejectedValue(new Error("No content")) } as unknown as Response);
      const client = makeClient(f);
      const result = await client.processes.execute(processName);
      expect(result.success).toBe(true);
      expect(result.processErrorStatus).toBe("CompletedSuccessfully");
    }), { numRuns: 100 });
  });

  it("failed process execution returns success: false with error message", async () => {
    const errorMsgArb = fc.string({ minLength: 1, maxLength: 100 });
    const statusArb = fc.constantFrom(400, 500);
    await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 30 }), errorMsgArb, statusArb, async (name, msg, status) => {
      const body = JSON.stringify({ error: { message: { value: msg } } });
      const f = vi.fn().mockResolvedValue({ ok: false, status, statusText: "Error", headers: new Headers(), text: vi.fn().mockResolvedValue(body), json: vi.fn().mockResolvedValue({ error: { message: { value: msg } } }) } as unknown as Response);
      const client = makeClient(f);
      const result = await client.processes.execute(name);
      expect(result.success).toBe(false);
      expect(typeof result.processErrorStatus).toBe("string");
      expect(result.processErrorStatus.length).toBeGreaterThan(0);
    }), { numRuns: 100 });
  });
});
