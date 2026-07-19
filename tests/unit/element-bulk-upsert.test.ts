import { describe, it, expect } from "vitest";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { ElementCreate } from "../../src/types.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// T3: bulkUpsert fans out the per-element REST calls with bounded concurrency
// WITHIN each pass, but must keep the pass barrier — every leaf write (pass 1)
// completes before any consolidation Components write (pass 2), because a
// consolidation references its leaves. These tests pin: (a) the barrier holds
// under concurrent settle, (b) typeChanges stays correct and in element order,
// (c) a genuine per-element failure still rejects the whole op before pass 2.

type Call = { method: string; path: string; body?: unknown };

interface FakeOpts {
  onPost?: (path: string, body: unknown) => unknown; // throw to simulate errors
  onGet?: (path: string) => unknown; // type-probe response
  delayMs?: number; // per-call latency so concurrent scheduling interleaves
}

function makeService(opts: FakeOpts = {}): { svc: ElementService; calls: Call[] } {
  const calls: Call[] = [];
  const delay = opts.delayMs ?? 0;
  const http = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (method === "POST" && opts.onPost) return opts.onPost(path, body) as T;
      if (method === "GET" && opts.onGet) return opts.onGet(path) as T;
      return undefined as T;
    },
  } as unknown as TM1HttpClient;
  const cells = {} as unknown as CellService;
  return { svc: new ElementService(http, cells), calls };
}

function alreadyExists(): TM1Error {
  return new TM1Error({
    code: TM1ErrorCode.TM1_ERROR,
    message: "An element with that name already exists",
    httpStatus: 409,
  });
}

const hasComponents = (c: Call): boolean => !!(c.body as { Components?: unknown }).Components;

describe("ElementService.bulkUpsert — pass barrier + concurrency", () => {
  it("runs all leaf writes (pass 1) before any consolidation Components write (pass 2)", async () => {
    const elements: ElementCreate[] = [
      { name: "L1", type: "Numeric" },
      { name: "L2", type: "Numeric" },
      { name: "L3", type: "String" },
      { name: "C1", type: "Consolidated", components: [{ name: "L1", weight: 1 }] },
      { name: "C2", type: "Consolidated", components: [{ name: "L2", weight: 1 }] },
    ];
    // Stagger latency so a broken barrier (pass 2 racing pass 1) surfaces as an
    // interleave rather than staying hidden behind deterministic ordering.
    const { svc, calls } = makeService({ delayMs: 5 });
    await svc.bulkUpsert("Dim", "Dim", elements);

    const lastPost = calls.reduce((acc, c, i) => (c.method === "POST" ? i : acc), -1);
    const firstComponentsPatch = calls.findIndex((c) => c.method === "PATCH" && hasComponents(c));
    expect(lastPost).toBeGreaterThanOrEqual(0);
    expect(firstComponentsPatch).toBeGreaterThanOrEqual(0);
    // Barrier: no Components-PATCH may precede any leaf/consolidation POST.
    expect(firstComponentsPatch).toBeGreaterThan(lastPost);

    expect(calls.filter((c) => c.method === "POST")).toHaveLength(5);
    expect(calls.filter((c) => c.method === "PATCH" && hasComponents(c))).toHaveLength(2);
  });

  it("skips consolidations with no/empty components (no Components PATCH)", async () => {
    const elements: ElementCreate[] = [
      { name: "L1", type: "Numeric" },
      { name: "C_empty", type: "Consolidated", components: [] },
      { name: "C_none", type: "Consolidated" },
    ];
    const { calls, svc } = makeService();
    await svc.bulkUpsert("Dim", "Dim", elements);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("reports type changes in element order under concurrent settle", async () => {
    // E1 and E3 already exist with a different type (→ change); E2 already exists
    // with the SAME type (no change). Concurrency must not scramble the order.
    const existingType: Record<string, string> = {
      "Elements('E1')?$select=Type": "String", // was String, upsert Numeric → change
      "Elements('E2')?$select=Type": "Numeric", // same → no change
      "Elements('E3')?$select=Type": "Numeric", // was Numeric, upsert String → change
    };
    const { svc } = makeService({
      delayMs: 3,
      onPost: () => {
        throw alreadyExists();
      },
      onGet: (path) => {
        const key = Object.keys(existingType).find((k) => path.endsWith(k));
        return { Type: existingType[key!] };
      },
    });
    const elements: ElementCreate[] = [
      { name: "E1", type: "Numeric" },
      { name: "E2", type: "Numeric" },
      { name: "E3", type: "String" },
    ];
    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", elements);
    expect(typeChanges).toEqual([
      { name: "E1", from: "String", to: "Numeric" },
      { name: "E3", from: "Numeric", to: "String" },
    ]);
  });

  it("rejects the whole op — before pass 2 — when a leaf write fails non-recoverably", async () => {
    const boom = new TM1Error({
      code: TM1ErrorCode.TM1_ERROR,
      message: "Invalid element type",
      httpStatus: 400,
    });
    const { svc, calls } = makeService({
      onPost: (_path, body) => {
        if ((body as { Name?: string }).Name === "L2") throw boom;
        return undefined;
      },
    });
    const elements: ElementCreate[] = [
      { name: "L1", type: "Numeric" },
      { name: "L2", type: "Numeric" },
      { name: "C1", type: "Consolidated", components: [{ name: "L1", weight: 1 }] },
    ];
    await expect(svc.bulkUpsert("Dim", "Dim", elements)).rejects.toBe(boom);
    // Barrier held: a failed pass 1 aborts BEFORE any Components PATCH runs.
    expect(calls.some((c) => c.method === "PATCH" && hasComponents(c))).toBe(false);
  });
});
