/**
 * Element-type cache for feeder audit heuristics.
 *
 * Looks up `(dim, hierarchy, element) → "Numeric" | "Consolidated" | "String"`
 * via the hierarchy service. One REST call per `(dim, hier)` pair; subsequent
 * lookups hit the in-memory map.
 *
 * Failure handling is bounded-retry, not cache-the-failure: the first
 * `MAX_CONSECUTIVE_LOAD_FAILURES - 1` failed loads leave the slot unset so a
 * later lookup retries and a transient timeout can heal; once that many
 * consecutive failures pile up the slot is pinned to `null` and no further
 * requests are issued for it. Concurrent lookups share the single in-flight
 * attempt, and a shared failing attempt counts as one failure — the budget is
 * spent per attempt, not per waiting caller.
 *
 * The read goes through `getElementTypes` (`$select=Name,Type`), not the full
 * `get()` — the latter drags `$expand=Parents` plus an Edges scan along for a
 * lookup that only needs the type.
 *
 * TM1 element name comparison is case-insensitive; normalize on both store and
 * lookup paths so positional/qualified mixing in feeders resolves correctly.
 */
import type { HierarchyElement } from "../../types.js";

export type ElementType = "Numeric" | "Consolidated" | "String";

interface HierarchyLike {
  getElementTypes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: HierarchyElement["type"] }>>;
}

const VALID_TYPES = new Set<ElementType>(["Numeric", "Consolidated", "String"]);

/**
 * Consecutive failed loads of one `(dim, hier)` slot before the cache stops
 * asking and pins that slot to `null` for its remaining lifetime.
 *
 * Balances two failure modes. Too low (1 = cache the failure) and a single
 * transient timeout marks every element of that dimension "type unknown" for
 * the whole audit run. Too high (unbounded retry) and a *deterministic*
 * failure — the common case, since TM1 reports a security denial as HTTP 400
 * `ObjectSecurityNoReadRights`, which any non-admin auditing a model with one
 * restricted dimension hits — costs one failing REST call per feeder entry,
 * serially, each able to run to the request timeout.
 *
 * No TTL on purpose: this cache is built fresh per tool invocation, so wall
 * clock buys nothing and would only drag `Date.now()` into the tests.
 */
const MAX_CONSECUTIVE_LOAD_FAILURES = 3;

function normalize(s: string): string {
  return s.toLowerCase();
}

export class ElementTypeCache {
  private readonly hierarchy: HierarchyLike;
  private readonly slots = new Map<string, Map<string, ElementType> | null>();
  private readonly pending = new Map<
    string,
    Promise<Map<string, ElementType> | null>
  >();
  /** Consecutive failed loads per slot; cleared on success, see load(). */
  private readonly failures = new Map<string, number>();

  constructor(hierarchy: HierarchyLike) {
    this.hierarchy = hierarchy;
  }

  async getType(
    dim: string,
    hier: string,
    elem: string,
  ): Promise<ElementType | null> {
    const slotKey = `${normalize(dim)}|${normalize(hier)}`;
    let slot = this.slots.get(slotKey);
    if (slot === undefined) {
      slot = await this.load(slotKey, dim, hier);
    }
    if (slot === null) return null;
    return slot.get(normalize(elem)) ?? null;
  }

  private async load(
    slotKey: string,
    dim: string,
    hier: string,
  ): Promise<Map<string, ElementType> | null> {
    const inflight = this.pending.get(slotKey);
    if (inflight) return inflight;

    // Resolver is created and registered eagerly so the in-flight slot is
    // populated before any await hands control back to other callers; the
    // actual REST work runs inside the returned promise.
    let resolve!: (v: Map<string, ElementType> | null) => void;
    const p = new Promise<Map<string, ElementType> | null>((r) => {
      resolve = r;
    });
    this.pending.set(slotKey, p);

    void (async () => {
      try {
        const elements = await this.hierarchy.getElementTypes(dim, hier);
        const m = new Map<string, ElementType>();
        for (const e of elements) {
          if (VALID_TYPES.has(e.type)) {
            m.set(normalize(e.name), e.type);
          }
        }
        this.slots.set(slotKey, m);
        this.failures.delete(slotKey);
        resolve(m);
      } catch {
        // One attempt = one failure, however many callers awaited it.
        const failed = (this.failures.get(slotKey) ?? 0) + 1;
        this.failures.set(slotKey, failed);
        if (failed >= MAX_CONSECUTIVE_LOAD_FAILURES) {
          // Budget spent: pin the slot so a deterministically broken or
          // access-denied dimension costs a bounded number of REST calls
          // instead of one per feeder entry.
          this.slots.set(slotKey, null);
        }
        // Below the threshold the slot stays unset, so the *next* getType()
        // issues a fresh attempt and a transient error can still heal.
        resolve(null);
      } finally {
        this.pending.delete(slotKey);
      }
    })();

    return p;
  }
}
