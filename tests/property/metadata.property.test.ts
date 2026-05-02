/**
 * Feature: tm1-mcp-server, Property 4: Metadaten-Antwort-Vollständigkeit
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1Client } from "../../src/tm1-client.js";
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
    keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info",
  };
}

function mockResp(body: unknown): Response {
  const t = JSON.stringify(body);
  return { ok: true, status: 200, statusText: "OK", headers: new Headers(),
    text: vi.fn().mockResolvedValue(t), json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

function makeClient(localFetch: ReturnType<typeof vi.fn>) {
  globalThis.fetch = localFetch as typeof fetch;
  const config = makeConfig();
  const sm = new SessionManager(config, mockLogger);
  vi.spyOn(sm, "ensureSession").mockResolvedValue("s");
  vi.spyOn(sm, "authenticate").mockResolvedValue("s");
  return new TM1Client(config, sm, mockLogger);
}

describe("Property 4: Metadaten-Antwort-Vollständigkeit", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("getCubes returns all cubes with name and dimensions", async () => {
    const cubeArb = fc.record({
      Name: fc.string({ minLength: 1, maxLength: 30 }),
      Dimensions: fc.array(fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }) }), { minLength: 1, maxLength: 5 }),
    });
    await fc.assert(fc.asyncProperty(fc.array(cubeArb, { minLength: 0, maxLength: 10 }), async (apiCubes) => {
      const f = vi.fn().mockResolvedValue(mockResp({ value: apiCubes }));
      const client = makeClient(f);
      const cubes = await client.getCubes();
      expect(cubes).toHaveLength(apiCubes.length);
      for (let i = 0; i < apiCubes.length; i++) {
        expect(cubes[i].name).toBe(apiCubes[i].Name);
        expect(cubes[i].dimensions).toEqual(apiCubes[i].Dimensions.map((d) => d.Name));
      }
    }), { numRuns: 100 });
  });

  it("getDimensions returns all dimensions with name and hierarchies", async () => {
    const dimArb = fc.record({
      Name: fc.string({ minLength: 1, maxLength: 30 }),
      Hierarchies: fc.array(fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }) }), { minLength: 1, maxLength: 5 }),
    });
    await fc.assert(fc.asyncProperty(fc.array(dimArb, { minLength: 0, maxLength: 10 }), async (apiDims) => {
      const f = vi.fn().mockResolvedValue(mockResp({ value: apiDims }));
      const client = makeClient(f);
      const dims = await client.getDimensions();
      expect(dims).toHaveLength(apiDims.length);
      for (let i = 0; i < apiDims.length; i++) {
        expect(dims[i].name).toBe(apiDims[i].Name);
        expect(dims[i].hierarchies).toEqual(apiDims[i].Hierarchies.map((h) => h.Name));
      }
    }), { numRuns: 100 });
  });

  it("getProcesses returns all processes with name and parameters", async () => {
    const paramArb = fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }), Type: fc.constantFrom("Numeric", "String"), Value: fc.oneof(fc.string({ maxLength: 30 }), fc.integer()) });
    const processArb = fc.record({ Name: fc.string({ minLength: 1, maxLength: 30 }), Parameters: fc.array(paramArb, { minLength: 0, maxLength: 5 }) });
    await fc.assert(fc.asyncProperty(fc.array(processArb, { minLength: 0, maxLength: 10 }), async (apiProcs) => {
      const f = vi.fn().mockResolvedValue(mockResp({ value: apiProcs }));
      const client = makeClient(f);
      const procs = await client.getProcesses();
      expect(procs).toHaveLength(apiProcs.length);
      for (let i = 0; i < apiProcs.length; i++) {
        expect(procs[i].name).toBe(apiProcs[i].Name);
        expect(procs[i].parameters).toHaveLength(apiProcs[i].Parameters.length);
        for (let j = 0; j < apiProcs[i].Parameters.length; j++) {
          expect(procs[i].parameters[j].name).toBe(apiProcs[i].Parameters[j].Name);
          expect(procs[i].parameters[j].type).toBe(apiProcs[i].Parameters[j].Type);
          expect(procs[i].parameters[j].defaultValue).toBe(apiProcs[i].Parameters[j].Value);
        }
      }
    }), { numRuns: 100 });
  });

  it("getChores returns all chores with name, schedule, and processes", async () => {
    const taskArb = fc.record({ Process: fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }), Parameters: fc.array(fc.record({ Name: fc.string({ minLength: 1, maxLength: 15 }), Value: fc.oneof(fc.string({ maxLength: 20 }), fc.integer()) }), { minLength: 0, maxLength: 3 }) }) });
    const choreArb = fc.record({ Name: fc.string({ minLength: 1, maxLength: 30 }), Active: fc.boolean(), StartTime: fc.constant("2024-01-01T00:00:00"), DSTSensitive: fc.boolean(), Frequency: fc.constantFrom("P1D", "PT1H", "P7D"), Tasks: fc.array(taskArb, { minLength: 0, maxLength: 3 }) });
    await fc.assert(fc.asyncProperty(fc.array(choreArb, { minLength: 0, maxLength: 5 }), async (apiChores) => {
      const f = vi.fn().mockResolvedValue(mockResp({ value: apiChores }));
      const client = makeClient(f);
      const chores = await client.getChores();
      expect(chores).toHaveLength(apiChores.length);
      for (let i = 0; i < apiChores.length; i++) {
        expect(chores[i].name).toBe(apiChores[i].Name);
        expect(typeof chores[i].active).toBe("boolean");
        expect(typeof chores[i].startTime).toBe("string");
        expect(typeof chores[i].frequency).toBe("string");
        expect(chores[i].processes).toHaveLength(apiChores[i].Tasks.length);
      }
    }), { numRuns: 100 });
  });
});
