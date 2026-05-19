/**
 * Element-type cache for feeder audit heuristics.
 *
 * Looks up `(dim, hierarchy, element) → "Numeric" | "Consolidated" | "String"`
 * via the hierarchy service. One REST call per `(dim, hier)` pair; subsequent
 * lookups hit the in-memory map. Failed fetches cache an empty result so we
 * don't hammer a broken endpoint.
 *
 * TM1 element name comparison is case-insensitive; normalize on both store and
 * lookup paths so positional/qualified mixing in feeders resolves correctly.
 */
import type { Hierarchy } from "../../types.js";

export type ElementType = "Numeric" | "Consolidated" | "String";

interface HierarchyLike {
  get(dimensionName: string, hierarchyName: string): Promise<Hierarchy>;
}

const VALID_TYPES = new Set<ElementType>(["Numeric", "Consolidated", "String"]);

function normalize(s: string): string {
  return s.toLowerCase();
}

export class ElementTypeCache {
  private readonly hierarchy: HierarchyLike;
  private readonly slots = new Map<string, Map<string, ElementType> | null>();
  private readonly pending = new Map<string, Promise<Map<string, ElementType> | null>>();

  constructor(hierarchy: HierarchyLike) {
    this.hierarchy = hierarchy;
  }

  async getType(dim: string, hier: string, elem: string): Promise<ElementType | null> {
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
        const h = await this.hierarchy.get(dim, hier);
        const m = new Map<string, ElementType>();
        for (const e of h.elements) {
          if (VALID_TYPES.has(e.type as ElementType)) {
            m.set(normalize(e.name), e.type as ElementType);
          }
        }
        this.slots.set(slotKey, m);
        resolve(m);
      } catch {
        this.slots.set(slotKey, null);
        resolve(null);
      } finally {
        this.pending.delete(slotKey);
      }
    })();

    return p;
  }
}
