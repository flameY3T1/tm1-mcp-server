/**
 * Feature: tm1-mcp-server, Property 5: Strukturierte Datentransformation
 *
 * **Validates: Requirements 3.1, 3.2, 3.5**
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { TM1Client } from "../../src/tm1-client.js";
import { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

const mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: "silent", flush: vi.fn() } as unknown as import("pino").Logger;
function makeConfig(): TM1Config { return { baseUrl: "https://tm1server:8010", user: "admin", password: "secret", ssl: { rejectUnauthorized: true }, keepAliveIntervalMs: 60000, requestTimeoutMs: 5000, logLevel: "info" }; }
function mockResp(body: unknown): Response { const t = JSON.stringify(body); return { ok: true, status: 200, statusText: "OK", headers: new Headers(), text: vi.fn().mockResolvedValue(t), json: vi.fn().mockResolvedValue(body) } as unknown as Response; }
const originalFetch = globalThis.fetch;
function makeClient(f: ReturnType<typeof vi.fn>) { globalThis.fetch = f as typeof fetch; const c = makeConfig(); const sm = new SessionManager(c, mockLogger); vi.spyOn(sm, "ensureSession").mockResolvedValue("s"); vi.spyOn(sm, "authenticate").mockResolvedValue("s"); return new TM1Client(c, sm, mockLogger); }

describe("Property 5: Strukturierte Datentransformation", () => {
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("executeMdx correctly maps all cells, formatted values, and axes", async () => {
    // Filter -0 out of doubles: vitest's toEqual uses Object.is, so -0 !== +0.
    const cellArb = fc.record({ Value: fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)), fc.constant(null), fc.string({ maxLength: 20 })), FormattedValue: fc.string({ maxLength: 30 }) });
    const memberArb = fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }), Hierarchy: fc.record({ Name: fc.string({ minLength: 1, maxLength: 20 }) }) });
    const tupleArb = fc.record({ Members: fc.array(memberArb, { minLength: 1, maxLength: 3 }) });
    const axisArb = fc.record({ Tuples: fc.array(tupleArb, { minLength: 1, maxLength: 5 }) });

    await fc.assert(fc.asyncProperty(fc.array(cellArb, { minLength: 1, maxLength: 10 }), fc.array(axisArb, { minLength: 1, maxLength: 2 }), async (cells, axes) => {
      const f = vi.fn().mockResolvedValue(mockResp({ ID: "cs-1", Cells: cells, Axes: axes }));
      const client = makeClient(f);
      const result = await client.executeMdx("SELECT {} ON COLUMNS FROM [Cube]");
      expect(result.cells).toHaveLength(cells.length);
      for (let i = 0; i < cells.length; i++) {
        expect(result.cells[i].value).toEqual(cells[i].Value);
        expect(result.cells[i].formattedValue).toBe(cells[i].FormattedValue);
      }
      expect(result.axes).toHaveLength(axes.length);
      for (let a = 0; a < axes.length; a++) {
        expect(result.axes[a].tuples).toHaveLength(axes[a].Tuples.length);
        for (let t = 0; t < axes[a].Tuples.length; t++) {
          expect(result.axes[a].tuples[t].members).toHaveLength(axes[a].Tuples[t].Members.length);
          for (let m = 0; m < axes[a].Tuples[t].Members.length; m++) {
            expect(result.axes[a].tuples[t].members[m].name).toBe(axes[a].Tuples[t].Members[m].Name);
            expect(result.axes[a].tuples[t].members[m].hierarchyName).toBe(axes[a].Tuples[t].Members[m].Hierarchy.Name);
          }
        }
      }
    }), { numRuns: 100 });
  });

  it("getView correctly maps cubeName, viewName, cells, and axes", async () => {
    const cellArb = fc.record({ Value: fc.oneof(fc.integer(), fc.constant(null)), FormattedValue: fc.string({ maxLength: 20 }) });
    const memberArb = fc.record({ Name: fc.string({ minLength: 1, maxLength: 15 }), Hierarchy: fc.record({ Name: fc.string({ minLength: 1, maxLength: 15 }) }) });
    const tupleArb = fc.record({ Members: fc.array(memberArb, { minLength: 1, maxLength: 2 }) });
    const axisArb = fc.record({ Tuples: fc.array(tupleArb, { minLength: 1, maxLength: 3 }) });

    await fc.assert(fc.asyncProperty(fc.array(cellArb, { minLength: 0, maxLength: 6 }), fc.array(axisArb, { minLength: 0, maxLength: 2 }), async (cells, axes) => {
      const f = vi.fn().mockResolvedValue(mockResp({ ID: "cs-2", Cells: cells, Axes: axes }));
      const client = makeClient(f);
      const result = await client.getView("TestCube", "TestView");
      expect(result.cubeName).toBe("TestCube");
      expect(result.viewName).toBe("TestView");
      expect(result.cells).toHaveLength(cells.length);
      expect(result.axes).toHaveLength(axes.length);
    }), { numRuns: 100 });
  });
});
