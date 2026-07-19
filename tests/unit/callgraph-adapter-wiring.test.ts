import { describe, it, expect, beforeEach } from "vitest";
import { tm1Events } from "../../src/lib/tm1-events.js";
import {
  registerCallgraphCacheInvalidation,
  buildIndexFromTM1,
  getCallgraphCacheStats,
  invalidateCallgraphCache,
} from "../../src/lib/callgraph/tm1-adapter.js";
import type { TM1Client } from "../../src/tm1-client.js";

// Minimal stub exposing only what buildIndexInternal touches. An empty model is
// enough to populate exactly one cache entry (key `inc=false`).
const stubClient = {
  processes: { fetchForCallgraph: async () => [] },
  cubes: { getAllRules: async () => [] },
  chores: { list: async () => [] },
} as unknown as TM1Client;

describe("A4 — callgraph cache-invalidation wiring is explicit", () => {
  beforeEach(() => {
    invalidateCallgraphCache();
  });

  it("importing the adapter does NOT auto-wire a mutation listener", () => {
    // Proves the former import-time side-effect is gone: nothing is wired until
    // registerCallgraphCacheInvalidation() is called explicitly. This assertion
    // runs before any register call (vitest isolates module state per file).
    expect(tm1Events.listeners("mutation")).toHaveLength(0);
  });

  it("without wiring, a mutation does NOT invalidate the cache", async () => {
    expect(tm1Events.listeners("mutation")).toHaveLength(0);
    await buildIndexFromTM1(stubClient);
    expect(getCallgraphCacheStats()).toHaveLength(1);

    tm1Events.emit("mutation", { method: "POST", path: "/x" });
    // No listener → cache survives.
    expect(getCallgraphCacheStats()).toHaveLength(1);
  });

  it("after explicit wiring, a mutation invalidates the cache (idempotent)", async () => {
    registerCallgraphCacheInvalidation();
    expect(tm1Events.listeners("mutation")).toHaveLength(1);
    // Second call must not stack a duplicate listener.
    registerCallgraphCacheInvalidation();
    expect(tm1Events.listeners("mutation")).toHaveLength(1);

    await buildIndexFromTM1(stubClient);
    expect(getCallgraphCacheStats()).toHaveLength(1);

    tm1Events.emit("mutation", { method: "POST", path: "/Cubes('c')/tm1.Update" });
    expect(getCallgraphCacheStats()).toHaveLength(0);
  });
});
