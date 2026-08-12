import { describe, it, expect, beforeEach } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
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
const stubClient = contractCheckedClient({
  processes: { fetchForCallgraph: async () => [] },
  cubes: { getAllRules: async () => [] },
  chores: { list: async () => [] },
} as unknown as TM1Client);

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

    // A code-relevant path: writing a process definition really does change the
    // reference graph. (This assertion used to use /Cubes('c')/tm1.Update —
    // that path is now classified as data-plane and deliberately inert, see the
    // dedicated test below.)
    tm1Events.emit("mutation", {
      method: "PATCH",
      path: "/api/v1/Processes('p')",
    });
    expect(getCallgraphCacheStats()).toHaveLength(0);
  });
});

describe("P2 — invalidation is precise and cannot publish a stale index", () => {
  beforeEach(() => {
    invalidateCallgraphCache();
  });

  // The reference index is built from process definitions, chore definitions
  // and cube rules. Cell traffic touches none of those — but it is POSTed, so
  // the HTTP layer calls it a mutation. Every tm1_execute_mdx used to discard
  // the whole index and force a rebuild on the next analysis call.
  it.each([
    ["/api/v1/ExecuteMDX", "POST"],
    ["/api/v1/Cellsets('abc')/Cells(0)", "PATCH"],
    ["/api/v1/Cubes('c')/tm1.Update", "POST"],
  ])("data-plane path %s does NOT invalidate", async (path, method) => {
    registerCallgraphCacheInvalidation();
    await buildIndexFromTM1(stubClient);
    expect(getCallgraphCacheStats()).toHaveLength(1);

    tm1Events.emit("mutation", { method, path });

    expect(getCallgraphCacheStats()).toHaveLength(1);
  });

  // Unrecognised paths must stay stale-safe: a new mutating endpoint added
  // later has to invalidate by default rather than silently serve old data.
  it("an unrecognised path still invalidates (fail-safe default)", async () => {
    registerCallgraphCacheInvalidation();
    await buildIndexFromTM1(stubClient);

    tm1Events.emit("mutation", {
      method: "POST",
      path: "/api/v1/SomethingNew",
    });

    expect(getCallgraphCacheStats()).toHaveLength(0);
  });

  // The actual correctness defect: clearing the map does not reach a build that
  // is already running. Without the generation guard that build finishes after
  // the mutation and writes its PRE-mutation snapshot back with a fresh
  // timestamp — stale data served as current for a full 60s TTL.
  it("a build that was in flight during an invalidation does not publish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowClient = contractCheckedClient({
      processes: {
        fetchForCallgraph: async () => {
          await gate;
          return [];
        },
      },
      cubes: { getAllRules: async () => [] },
      chores: { list: async () => [] },
    } as unknown as TM1Client);

    const pending = buildIndexFromTM1(slowClient);

    // Mutation lands while the build is still awaiting the server.
    invalidateCallgraphCache();

    release();
    await pending;

    expect(getCallgraphCacheStats()).toHaveLength(0);
  });

  it("a build with no concurrent invalidation still publishes", async () => {
    await buildIndexFromTM1(stubClient);
    expect(getCallgraphCacheStats()).toHaveLength(1);
  });
});
