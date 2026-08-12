// The safety argument for bulkUpsert's $batch -> per-request fallback rests on
// one invariant: the ONLY pass that can run inside the fallback-eligible window
// is pass 1a, which is create-only. Everything destructive (pass 1c Type PATCH,
// pass 2 Components) runs strictly after a batch has succeeded, and a batch
// failing after that propagates instead of falling back.
//
// That invariant is a property of pass ORDER, not something the type system
// enforces — pull a destructive pass forward and the fallback silently starts
// replaying it. These tests pin both halves so a reorder fails loudly.
//
// The `StatefulElementBatchModel` below deliberately carries STATE and applies
// sub-requests as it processes them, so the injected failure leaves earlier
// sub-requests COMMITTED. That is not hypothetical: TM1's $batch is non-atomic
// (verified live against 11.8 — a failing sub-request leaves its siblings
// committed), and an ambiguous 500 can arrive after the server applied part of
// the envelope. The other batch suites use stateless fakes and cannot express
// this.
//
// ---------------------------------------------------------------------------
// WHAT StatefulElementBatchModel MODELS — AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// It is NOT a TM1 simulator. It is a narrow model of exactly the element and
// $batch behaviours this suite's invariant depends on. Anything not listed
// under "modelled" is absent, and a test that appears to exercise it is
// exercising nothing.
//
// Modelled (deliberately, because the invariant needs it):
//   - An element store keyed by name, each with `type` and `hasLeafData`.
//   - POST create: rejects a duplicate name with a TM1Error carrying
//     httpStatus 400 and the v11 wording `An element with name "X" already
//     exists.` — v11 really does answer 400 here, not 409.
//   - GET: returns the stored `Type` only.
//   - PATCH `Type`: applied in place; a Numeric -> non-Numeric change on an
//     element with `hasLeafData` is recorded in `destructive` and clears
//     `hasLeafData` — this stands in for TM1 discarding leaf cell values on
//     that conversion. Nothing else about cell data is modelled.
//   - PATCH `Components`: stored verbatim, no validation of the component
//     graph, no rollup, no circularity check.
//   - $batch envelopes: sub-requests are applied IN ORDER and each one COMMITS
//     as it is applied, so an injected failure at index N leaves 0..N-1
//     committed — the non-atomicity that is the whole point of this file.
//   - BatchService's counter-probe (`BATCH_PROBE_ID`): answered with a canned
//     200 without touching state or the envelope counter.
//   - Injected failures: one configurable (envelope index, sub-request index,
//     status) throw, defaulting to 500.
//
// NOT modelled — do not read a passing test here as evidence about any of it:
//   - Authentication, sessions, session expiry, CAM, keep-alive.
//   - OData name escaping: element names are pulled out of the path with a
//     plain regex, so a name containing a quote or a percent-encoded character
//     is neither escaped nor round-tripped correctly.
//   - Pagination, $top/$skip/$count, $filter, $select, $expand.
//   - Real v11 error bodies: errors are TM1Error objects, not the OData
//     `error.code`/`error.message` envelope the client parses in production.
//     Error-shape parsing must be tested elsewhere.
//   - The 32 KB request limit, chunking, or any transport-level concern.
//   - Hierarchies, dimensions, attributes, subsets, views, cubes, cells.
//   - Element deletion, renaming, or moving.
//   - Concurrency, locking, or the TM1 transaction log.
//   - $batch atomicity semantics of any server other than v11 11.8.
import { describe, it, expect } from "vitest";
import { contractCheckedHttp } from "../helpers/contract-http.js";
import { ElementService } from "../../src/tm1-client/services/element-service.js";
import {
  BATCH_PROBE_ID,
  BatchService,
} from "../../src/tm1-client/services/batch-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { CellService } from "../../src/tm1-client/services/cell-service.js";
import type { ElementCreate } from "../../src/types.js";
import { TM1Error, TM1ErrorCode } from "../../src/types.js";

interface FakeElement {
  type: string;
  /** Stands in for leaf cell values: a Numeric->non-Numeric PATCH discards it. */
  hasLeafData: boolean;
  components?: unknown;
}

interface Injection {
  /** 0-based index of the $batch envelope to fail. */
  envelope: number;
  /** Sub-requests to APPLY before throwing — these stay committed. */
  applyBefore: number;
  /**
   * Envelope-level status. 500 (the default) is the mid-commit case; 400 is the
   * ambiguous one that makes BatchService counter-probe before it concludes
   * anything.
   */
  status?: number;
}

/** Minimal stateful TM1 stand-in: elements, types, and destructive conversions. */
class StatefulElementBatchModel {
  readonly elements = new Map<string, FakeElement>();
  /** Every Numeric -> non-Numeric conversion, i.e. every destructive write. */
  readonly destructive: string[] = [];
  /** Kind of every sub-request applied inside a $batch envelope. */
  readonly batchApplied: string[] = [];
  /** Kind of every call that went down the per-request path. */
  readonly perRequestApplied: string[] = [];
  /** How many counter-probes BatchService fired. */
  probes = 0;
  private envelopeSeq = 0;

  constructor(
    seed: Record<string, { type: string; hasLeafData?: boolean }>,
    private readonly inject?: Injection,
  ) {
    for (const [name, v] of Object.entries(seed)) {
      this.elements.set(name, {
        type: v.type,
        hasLeafData: v.hasLeafData ?? false,
      });
    }
  }

  private kind(method: string, body: unknown): string {
    if (method === "POST") return "POST create";
    if (method === "GET") return "GET type";
    const b = body as { Type?: unknown; Components?: unknown } | undefined;
    if (b?.Components !== undefined) return "PATCH components";
    if (b?.Type !== undefined) return "PATCH type";
    return `${method} other`;
  }

  private apply(method: string, path: string, body: unknown): unknown {
    if (method === "POST") {
      const b = body as { Name: string; Type: string };
      if (this.elements.has(b.Name)) {
        throw new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          httpStatus: 400,
          message: `An element with name "${b.Name}" already exists. Failed to create element.`,
        });
      }
      this.elements.set(b.Name, { type: b.Type, hasLeafData: false });
      return {};
    }
    const name = /Elements\('([^']*)'\)/.exec(path)?.[1] ?? "";
    const el = this.elements.get(name);
    if (!el) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        httpStatus: 404,
        message: `Element "${name}" not found`,
      });
    }
    if (method === "GET") return { Type: el.type };
    const b = body as { Type?: string; Components?: unknown };
    if (b.Components !== undefined) {
      el.components = b.Components;
      return {};
    }
    if (b.Type !== undefined) {
      if (el.type === "Numeric" && b.Type !== "Numeric" && el.hasLeafData) {
        this.destructive.push(`${name}:${el.type}->${b.Type}`);
        el.hasLeafData = false;
      }
      el.type = b.Type;
    }
    return {};
  }

  http(): TM1HttpClient {
    return contractCheckedHttp({
      request: async <T>(
        method: string,
        path: string,
        body?: unknown,
      ): Promise<T> => {
        if (path !== "/api/v1/$batch") {
          this.perRequestApplied.push(this.kind(method, body));
          return this.apply(method, path, body) as T;
        }
        const requests = (
          body as {
            requests: Array<{
              id: string;
              method: string;
              url: string;
              body?: unknown;
            }>;
          }
        ).requests;
        // BatchService's counter-probe: a single side-effect-free GET it sends
        // to decide whether an ambiguous 400 meant "no $batch" or "bad
        // payload". Answer it WITHOUT touching state or the envelope counter —
        // it is not one of the caller's envelopes, and treating it as one would
        // shift every later injection index.
        if (requests.length === 1 && requests[0].id === BATCH_PROBE_ID) {
          this.probes++;
          return {
            responses: [
              { id: BATCH_PROBE_ID, status: 200, body: { value: "11.8" } },
            ],
          } as T;
        }
        const seq = this.envelopeSeq++;
        const responses: Array<{ id: string; status: number; body?: unknown }> =
          [];
        for (const [i, r] of requests.entries()) {
          if (
            this.inject &&
            this.inject.envelope === seq &&
            i === this.inject.applyBefore
          ) {
            // Sub-requests 0..i-1 are ALREADY committed at this point.
            const status = this.inject.status ?? 500;
            throw new TM1Error({
              code: TM1ErrorCode.TM1_ERROR,
              httpStatus: status,
              message: `injected HTTP ${status} on $batch envelope ${seq}`,
            });
          }
          this.batchApplied.push(this.kind(r.method, r.body));
          try {
            responses.push({
              id: r.id,
              status: 200,
              body: this.apply(r.method, `/api/v1/${r.url}`, r.body),
            });
          } catch (e) {
            const err = e as TM1Error;
            responses.push({
              id: r.id,
              status: err.httpStatus ?? 500,
              body: { error: { message: err.message } },
            });
          }
        }
        return { responses } as T;
      },
    } as unknown as TM1HttpClient);
  }

  snapshot(): unknown {
    return [...this.elements.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, e]) => ({
        n,
        type: e.type,
        hasLeafData: e.hasLeafData,
        components: e.components ?? null,
      }));
  }
}

function serviceFor(
  fake: StatefulElementBatchModel,
  withBatch: boolean,
): ElementService {
  const http = fake.http();
  const cells = {} as unknown as CellService;
  return withBatch
    ? new ElementService(http, cells, new BatchService(http))
    : new ElementService(http, cells);
}

// A pre-existing Numeric leaf WITH data that the upsert converts to
// Consolidated is the destructive case the fallback must never repeat.
const SEED = { seedNumericWithData: { type: "Numeric", hasLeafData: true } };
const ELEMENTS: ElementCreate[] = [
  { name: "leafA", type: "Numeric" },
  { name: "leafB", type: "Numeric" },
  { name: "seedNumericWithData", type: "Consolidated" },
  {
    name: "consol",
    type: "Consolidated",
    components: [
      { name: "leafA", weight: 1 },
      { name: "leafB", weight: 1 },
    ],
  },
];

describe("bulkUpsert $batch fallback safety", () => {
  it("a partially committed first envelope falls back without repeating destructive work", async () => {
    // Reference: what the per-request path alone produces.
    const ref = new StatefulElementBatchModel(SEED);
    const refResult = await serviceFor(ref, false).bulkUpsert(
      "Dim",
      "Dim",
      ELEMENTS,
    );
    expect(ref.destructive).toEqual([
      "seedNumericWithData:Numeric->Consolidated",
    ]);

    // Same workload, but the first envelope dies after committing 3 creates.
    const f = new StatefulElementBatchModel(SEED, {
      envelope: 0,
      applyBefore: 3,
    });
    const result = await serviceFor(f, true).bulkUpsert("Dim", "Dim", ELEMENTS);

    // Only creates can ever be in flight in the fallback-eligible window. If a
    // destructive pass is ever moved ahead of the first successful batch, this
    // is the assertion that fails.
    expect([...new Set(f.batchApplied)]).toEqual(["POST create"]);
    // Committed creates were replayed, yet the destructive conversion happened
    // exactly once and the end state matches a clean per-request run.
    expect(f.destructive).toEqual([
      "seedNumericWithData:Numeric->Consolidated",
    ]);
    expect(f.snapshot()).toEqual(ref.snapshot());
    expect(result.typeChanges).toEqual(refResult.typeChanges);
  });

  it("a first-envelope 400 whose counter-probe passes propagates instead of falling back", async () => {
    // The other side of the coin: the first envelope fails 400, but $batch
    // itself demonstrably works (the counter-probe gets a clean envelope back).
    // The 400 was therefore about the payload, and treating it as "this server
    // has no $batch" would drop the whole session onto the per-request path for
    // a reason that will never be true again. It must surface as a real error —
    // and, exactly as with the post-success case, must not silently re-drive
    // the writes down the other path.
    const f = new StatefulElementBatchModel(SEED, {
      envelope: 0,
      applyBefore: 3,
      status: 400,
    });

    await expect(
      serviceFor(f, true).bulkUpsert("Dim", "Dim", ELEMENTS),
    ).rejects.toThrow(TM1Error);
    expect(f.perRequestApplied).toEqual([]);
    expect(f.probes).toBe(1);
  });

  it("a failure after the first successful batch propagates instead of falling back", async () => {
    // Envelope 0 = creates, 1 = type probes, 2 = the destructive type PATCHes.
    const f = new StatefulElementBatchModel(SEED, {
      envelope: 2,
      applyBefore: 0,
    });

    await expect(
      serviceFor(f, true).bulkUpsert("Dim", "Dim", ELEMENTS),
    ).rejects.toThrow(TM1Error);
    // The decisive part: no silent re-drive of the writes down the other path.
    expect(f.perRequestApplied).toEqual([]);
  });
});
