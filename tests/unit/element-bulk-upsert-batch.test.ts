import { describe, it, expect } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import {
  BatchService,
  BatchUnsupportedError,
} from "../../src/tm1-client/services/batch-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { ElementCreate } from "../../src/types.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

// bulkUpsert prefers OData $batch and falls back to the per-request fan-out.
// These pin the batch path against the SAME contract the per-request path has
// (element-bulk-upsert.test.ts): pass barrier, typeChanges in element order,
// throw-on-any-hard-failure — plus the fallback and its safety rules.

type SubRequest = { id: string; method: string; url: string; body?: unknown };
type SubResponse = { id: string; status: number; body?: unknown };

interface FakeOpts {
  /** Per-sub-request outcome. Return a status (+body) or undefined for 200. */
  onSub?: (r: SubRequest) => SubResponse | undefined;
  /** Fail the whole envelope. */
  throwOnBatch?: Error;
}

function makeService(opts: FakeOpts = {}): {
  svc: ElementService;
  batches: SubRequest[][];
  perRequest: Array<{ method: string; path: string }>;
} {
  const batches: SubRequest[][] = [];
  const perRequest: Array<{ method: string; path: string }> = [];
  const http = contractCheckedHttp({
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path === "/api/v1/$batch") {
        if (opts.throwOnBatch) throw opts.throwOnBatch;
        const requests = (body as { requests: SubRequest[] }).requests;
        batches.push(requests);
        return {
          responses: requests.map(
            (r) => opts.onSub?.(r) ?? { id: r.id, status: 200, body: {} },
          ),
        } as T;
      }
      perRequest.push({ method, path });
      return undefined as T;
    },
  } as unknown as TM1HttpClient);
  const cells = {} as unknown as CellService;
  const batch = new BatchService(http);
  return { svc: new ElementService(http, cells, batch), batches, perRequest };
}

const alreadyExists = (id: string): SubResponse => ({
  id,
  status: 400,
  body: {
    error: {
      message:
        'An element with name "x" already exists. Failed to create element.',
    },
  },
});

const isComponentsPatch = (r: SubRequest): boolean =>
  r.method === "PATCH" &&
  !!(r.body as { Components?: unknown } | undefined)?.Components;

describe("ElementService.bulkUpsert — $batch path", () => {
  it("creates every element in ONE batch instead of one call each", async () => {
    const { svc, batches, perRequest } = makeService();
    const elements: ElementCreate[] = Array.from({ length: 50 }, (_, i) => ({
      name: `L${i}`,
      type: "Numeric",
    }));

    await svc.bulkUpsert("Dim", "Dim", elements);

    // No element ever goes out as its own HTTP request.
    expect(perRequest).toHaveLength(0);
    const creates = batches.flat().filter((r) => r.method === "POST");
    expect(creates).toHaveLength(50);
    expect(creates[0].url).toBe(
      "Dimensions('Dim')/Hierarchies('Dim')/Elements",
    );
    expect(creates[0].body).toEqual({ Name: "L0", Type: "Numeric" });
  });

  it("holds the pass barrier: no Components PATCH before the last leaf create", async () => {
    const { svc, batches } = makeService();
    const elements: ElementCreate[] = [
      { name: "L1", type: "Numeric" },
      { name: "L2", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
      {
        name: "C2",
        type: "Consolidated",
        components: [{ name: "L2", weight: -1 }],
      },
    ];
    await svc.bulkUpsert("Dim", "Dim", elements);

    const flat = batches.flat();
    const lastPost = flat.reduce(
      (acc, r, i) => (r.method === "POST" ? i : acc),
      -1,
    );
    const firstComponents = flat.findIndex(isComponentsPatch);
    expect(lastPost).toBeGreaterThanOrEqual(0);
    expect(firstComponents).toBeGreaterThan(lastPost);
    // Components arrive as OData refs with their weights.
    expect(
      (flat[firstComponents].body as { Components: unknown[] }).Components,
    ).toEqual([
      {
        "@odata.id": "Dimensions('Dim')/Hierarchies('Dim')/Elements('L1')",
        Weight: 1,
      },
    ]);
  });

  it("skips consolidations with no/empty components", async () => {
    const { svc, batches } = makeService();
    await svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      { name: "C_empty", type: "Consolidated", components: [] },
      { name: "C_none", type: "Consolidated" },
    ]);
    expect(batches.flat().filter(isComponentsPatch)).toHaveLength(0);
  });

  it("reports type changes in element order and patches only what differs", async () => {
    // E1/E2/E3 all exist. E1 String->Numeric (change), E2 same type (no write),
    // E3 Numeric->String (change).
    const existingType: Record<string, string> = {
      E1: "String",
      E2: "Numeric",
      E3: "Numeric",
    };
    const { svc, batches } = makeService({
      onSub: (r) => {
        if (r.method === "POST") return alreadyExists(r.id);
        if (r.method === "GET") {
          const name = /Elements\('([^']+)'\)/.exec(r.url)![1];
          return { id: r.id, status: 200, body: { Type: existingType[name] } };
        }
        return undefined;
      },
    });

    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", [
      { name: "E1", type: "Numeric" },
      { name: "E2", type: "Numeric" },
      { name: "E3", type: "String" },
    ]);

    expect(typeChanges).toEqual([
      { name: "E1", from: "String", to: "Numeric" },
      { name: "E3", from: "Numeric", to: "String" },
    ]);
    // E2 is untouched — no pointless write.
    const typePatches = batches.flat().filter((r) => r.method === "PATCH");
    expect(typePatches.map((r) => r.url)).toEqual([
      "Dimensions('Dim')/Hierarchies('Dim')/Elements('E1')",
      "Dimensions('Dim')/Hierarchies('Dim')/Elements('E3')",
    ]);
  });

  it("patches unconditionally, and reports no change, when the prior type is unreadable", async () => {
    const { svc, batches } = makeService({
      onSub: (r) => {
        if (r.method === "POST") return alreadyExists(r.id);
        if (r.method === "GET") {
          return {
            id: r.id,
            status: 404,
            body: { error: { message: "not found" } },
          };
        }
        return undefined;
      },
    });
    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", [
      { name: "E1", type: "Numeric" },
    ]);
    expect(typeChanges).toEqual([]);
    const patches = batches.flat().filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ Type: "Numeric" });
  });

  // The type probe decides whether the Type gets PATCHed. A systemic failure
  // (expired session, socket death) must NOT read as "type unreadable": that
  // would rewrite the type and discard the element's leaf cell values on a
  // blip, and report nothing in typeChanges. Mirrors the per-request guard.
  it("propagates a systemic probe failure instead of patching the type", async () => {
    const { svc, batches } = makeService({
      onSub: (r) => {
        if (r.method === "POST") return alreadyExists(r.id);
        if (r.method === "GET") {
          return {
            id: r.id,
            status: 401,
            body: { error: { message: "Authentication failed" } },
          };
        }
        return undefined;
      },
    });

    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "E1", type: "String" }]),
    ).rejects.toMatchObject({ code: TM1ErrorCode.AUTH_FAILED });
    // Nothing was rewritten.
    expect(batches.flat().filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  // "already exists" is matched on the message TEXT, so the sub-response error
  // must carry that text even when the body is not the familiar
  // {error:{message}} envelope — otherwise a re-upsert throws instead of
  // updating.
  it("still recognises already-exists when the error body shape is unfamiliar", async () => {
    const { svc } = makeService({
      onSub: (r) => {
        if (r.method === "POST") {
          return {
            id: r.id,
            status: 400,
            body: { Message: 'An element with name "E1" already exists.' },
          };
        }
        if (r.method === "GET")
          return { id: r.id, status: 200, body: { Type: "Numeric" } };
        return undefined;
      },
    });

    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "E1", type: "Numeric" }]),
    ).resolves.toEqual({
      typeChanges: [],
    });
  });

  it("uses element index (not name) to correlate, so duplicate names cannot collide", async () => {
    const { svc, batches } = makeService();
    await svc.bulkUpsert("Dim", "Dim", [
      { name: "DUP", type: "Numeric" },
      { name: "DUP", type: "Numeric" },
    ]);
    const ids = batches.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects with the FIRST failure in element order, before pass 2", async () => {
    const { svc, batches } = makeService({
      onSub: (r) => {
        const name = (r.body as { Name?: string } | undefined)?.Name;
        if (name === "L2") {
          return {
            id: r.id,
            status: 400,
            body: { error: { message: "Invalid element type L2" } },
          };
        }
        if (name === "L3") {
          return {
            id: r.id,
            status: 400,
            body: { error: { message: "Invalid element type L3" } },
          };
        }
        return undefined;
      },
    });

    await expect(
      svc.bulkUpsert("Dim", "Dim", [
        { name: "L1", type: "Numeric" },
        { name: "L2", type: "Numeric" },
        { name: "L3", type: "Numeric" },
        {
          name: "C1",
          type: "Consolidated",
          components: [{ name: "L1", weight: 1 }],
        },
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining("L2") });

    // Barrier held — the consolidation write never ran.
    expect(batches.flat().some(isComponentsPatch)).toBe(false);
  });

  it("rejects when a Components PATCH fails", async () => {
    const { svc } = makeService({
      onSub: (r) =>
        isComponentsPatch(r)
          ? {
              id: r.id,
              status: 400,
              body: { error: { message: "bad component ref" } },
            }
          : undefined,
    });
    await expect(
      svc.bulkUpsert("Dim", "Dim", [
        { name: "L1", type: "Numeric" },
        {
          name: "C1",
          type: "Consolidated",
          components: [{ name: "L1", weight: 1 }],
        },
      ]),
    ).rejects.toMatchObject({ message: "bad component ref" });
  });
});

describe("ElementService.bulkUpsert — fallback to the per-request path", () => {
  it("falls back when the server has no $batch endpoint", async () => {
    const { svc, perRequest } = makeService({
      throwOnBatch: new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: "no $batch here",
        httpStatus: 404,
      }),
    });

    const { typeChanges } = await svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
    ]);

    expect(typeChanges).toEqual([]);
    // The old path ran: one POST per element plus the Components PATCH.
    expect(perRequest.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(perRequest.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("does not re-probe $batch on a later bulkUpsert once it is known unsupported", async () => {
    let batchAttempts = 0;
    const http = contractCheckedHttp({
      async request<T>(_method: string, path: string): Promise<T> {
        if (path === "/api/v1/$batch") {
          batchAttempts++;
          throw new TM1Error({
            code: TM1ErrorCode.NOT_FOUND,
            message: "nope",
            httpStatus: 404,
          });
        }
        return undefined as T;
      },
    } as unknown as TM1HttpClient);
    const svc = new ElementService(
      http,
      {} as unknown as CellService,
      new BatchService(http),
    );

    await svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]);
    await svc.bulkUpsert("Dim", "Dim", [{ name: "L2", type: "Numeric" }]);
    expect(batchAttempts).toBe(1);
  });

  it("does NOT fall back on a systemic transport failure (no silent re-drive of writes)", async () => {
    const boom = new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: "socket died",
    });
    const { svc, perRequest } = makeService({ throwOnBatch: boom });
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).rejects.toBe(boom);
    expect(perRequest).toHaveLength(0);
  });

  it("does NOT fall back on a sub-request failure — that is a real element error", async () => {
    const { svc, perRequest } = makeService({
      onSub: (r) => ({
        id: r.id,
        status: 400,
        body: { error: { message: "Invalid element type" } },
      }),
    });
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).rejects.toMatchObject({ message: "Invalid element type" });
    expect(perRequest).toHaveLength(0);
  });

  it("uses the per-request path when no BatchService is wired", async () => {
    const calls: string[] = [];
    const http = contractCheckedHttp({
      async request<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        return undefined as T;
      },
    } as unknown as TM1HttpClient);
    const svc = new ElementService(http, {} as unknown as CellService);
    await svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]);
    expect(calls.some((c) => c.includes("$batch"))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("BatchUnsupportedError never escapes bulkUpsert", async () => {
    const { svc } = makeService({
      throwOnBatch: new BatchUnsupportedError("synthetic"),
    });
    // A BatchUnsupportedError thrown by the transport stub is not a TM1Error, so
    // it propagates out of BatchService untouched — bulkUpsert must still treat
    // it as "no batch" and complete via the fallback.
    await expect(
      svc.bulkUpsert("Dim", "Dim", [{ name: "L1", type: "Numeric" }]),
    ).resolves.toEqual({
      typeChanges: [],
    });
  });
});

// Same weight contract as the per-request path, plus the one thing only the
// batch path can get wrong: two edges under one element must not reuse an id.
// v12 rejects an envelope with duplicate ids outright.
describe("bulkUpsert batch path — consolidation weights", () => {
  const WEIGHTED: ElementCreate[] = [
    { name: "L1", type: "Numeric" },
    { name: "L2", type: "Numeric" },
    {
      name: "C1",
      type: "Consolidated",
      components: [
        { name: "L1", weight: -1 },
        { name: "L2", weight: 3 },
      ],
    },
  ];

  it("PATCHes each deviating Edge, with unique ids, after the Components pass", async () => {
    const { svc, batches } = makeService();
    await svc.bulkUpsert("Dim", "Dim", WEIGHTED);

    const edgeBatch = batches.find((reqs) =>
      reqs.some((r) => r.url.includes("/Edges(")),
    );
    expect(edgeBatch).toBeDefined();
    expect(edgeBatch).toHaveLength(2);
    expect(new Set(edgeBatch!.map((r) => r.id)).size).toBe(2);
    expect(edgeBatch!.map((r) => r.body)).toEqual([
      { Weight: -1 },
      { Weight: 3 },
    ]);

    // Order: the edge has to exist before its weight can be set.
    const componentsBatchIdx = batches.findIndex((reqs) =>
      reqs.some((r) => (r.body as { Components?: unknown })?.Components),
    );
    expect(batches.indexOf(edgeBatch!)).toBeGreaterThan(componentsBatchIdx);
  });

  it("a rejected weight fails the whole upsert", async () => {
    const { svc } = makeService({
      onSub: (r) =>
        r.url.includes("/Edges(")
          ? { id: r.id, status: 400, body: { error: { message: "nope" } } }
          : undefined,
    });
    await expect(svc.bulkUpsert("Dim", "Dim", WEIGHTED)).rejects.toThrow();
  });

  it("sends no weight batch when every weight is 1", async () => {
    const { svc, batches } = makeService();
    await svc.bulkUpsert("Dim", "Dim", [
      { name: "L1", type: "Numeric" },
      {
        name: "C1",
        type: "Consolidated",
        components: [{ name: "L1", weight: 1 }],
      },
    ]);
    expect(
      batches.some((reqs) => reqs.some((r) => r.url.includes("/Edges("))),
    ).toBe(false);
  });
});
