/**
 * Feature: tm1-mcp-server, Property 9: Prozesscode-Tab-Vollständigkeit
 * Feature: tm1-mcp-server, Property 10: Partielle Tab-Aktualisierung
 *
 * **Validates: Requirements 5.2** (Property 9)
 * **Validates: Requirements 5.3** (Property 10)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: "silent", flush: vi.fn() } as unknown as import("pino").Logger;
function makeConfig(): TM1Config { return { baseUrl: "https://tm1server:8010", user: "admin", password: "secret", ssl: { rejectUnauthorized: true }, keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info" }; }
function mockResp(body: unknown): Response { const t = JSON.stringify(body); return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: vi.fn().mockResolvedValue(t), json: vi.fn().mockResolvedValue(body) } as unknown as Response; }
function mock204(): Response { return { ok: true, status: 204, statusText: "No Content", headers: new Headers(), text: vi.fn().mockResolvedValue(""), json: vi.fn().mockRejectedValue(new Error("No content")) } as unknown as Response; }
const originalFetch = globalThis.fetch;
function makeClient(f: ReturnType<typeof vi.fn>) { globalThis.fetch = f as typeof fetch; const c = makeConfig(); const sm = new SessionManager(c, mockLogger); vi.spyOn(sm, "ensureSession").mockResolvedValue("s"); vi.spyOn(sm, "authenticate").mockResolvedValue("s"); return new TM1Client(c, sm, mockLogger); }

describe("Property 9: Prozesscode-Tab-Vollständigkeit", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("getProcessCode returns exactly four fields, none undefined", async () => {
    const codeArb = fc.record({ PrologProcedure: fc.string({ maxLength: 200 }), MetadataProcedure: fc.string({ maxLength: 200 }), DataProcedure: fc.string({ maxLength: 200 }), EpilogProcedure: fc.string({ maxLength: 200 }) });
    await fc.assert(fc.asyncProperty(codeArb, async (apiCode) => {
      const f = vi.fn().mockResolvedValue(mockResp({ Name: "TestProcess", ...apiCode }));
      const client = makeClient(f);
      const code = await client.processes.getCode("TestProcess");
      const keys = Object.keys(code);
      expect(keys).toHaveLength(4);
      expect(keys.sort()).toEqual(["data", "epilog", "metadata", "prolog"]);
      expect(code.prolog).not.toBeUndefined();
      expect(code.metadata).not.toBeUndefined();
      expect(code.data).not.toBeUndefined();
      expect(code.epilog).not.toBeUndefined();
      expect(code.prolog).toBe(apiCode.PrologProcedure);
      expect(code.metadata).toBe(apiCode.MetadataProcedure);
      expect(code.data).toBe(apiCode.DataProcedure);
      expect(code.epilog).toBe(apiCode.EpilogProcedure);
    }), { numRuns: 100 });
  });
});

describe("Property 10: Partielle Tab-Aktualisierung", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("only specified tabs are sent in PATCH, unspecified tabs are omitted", async () => {
    const tabNames = ["prolog", "metadata", "data", "epilog"] as const;
    const apiFieldMap: Record<string, string> = { prolog: "PrologProcedure", metadata: "MetadataProcedure", data: "DataProcedure", epilog: "EpilogProcedure" };
    const subsetArb = fc.subarray(["prolog", "metadata", "data", "epilog"] as const, { minLength: 1 });
    const codeValueArb = fc.string({ minLength: 1, maxLength: 100 });

    await fc.assert(fc.asyncProperty(subsetArb, codeValueArb, async (tabSubset, newCode) => {
      const f = vi.fn().mockResolvedValue(mock204());
      const client = makeClient(f);
      const partialCode: Record<string, string> = {};
      for (const tab of tabSubset) partialCode[tab] = newCode;
      await client.processes.updateCode("TestProcess", partialCode);

      expect(f).toHaveBeenCalledOnce();
      const [, opts] = f.mock.calls[0];
      const body = JSON.parse(opts.body);
      for (const tab of tabSubset) expect(body[apiFieldMap[tab]]).toBe(newCode);
      for (const tab of tabNames) {
        if (!tabSubset.includes(tab)) expect(body[apiFieldMap[tab]]).toBeUndefined();
      }
    }), { numRuns: 100 });
  });
});
