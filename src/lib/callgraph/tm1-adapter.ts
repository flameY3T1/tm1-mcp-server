import type { TM1Client } from "../../tm1-client.js";
import {
  buildReferenceIndex,
  type ReferenceIndex,
  type ProcessFetchResult,
  type CubeRulesFetchResult,
  type ChoreFetchResult,
  type ChoreTaskRef,
} from "./referenceIndex.js";
import { tm1Events, type Tm1MutationEvent } from "../tm1-events.js";
import { rethrowIfSystemic } from "../../tm1-client/services/fallback.js";

// Cache-invalidation listener. Wired EXPLICITLY via
// registerCallgraphCacheInvalidation() at client construction — no import-time
// side-effect. Keeping this a named, stable function reference lets the wiring
// be idempotent (the registrar checks for it before re-adding).
// Data-plane paths that can never change the reference graph. The index is
// built from process definitions, chore definitions and cube rules; none of
// these endpoints touches any of that.
//
// This matters more than it looks: `ExecuteMDX` is a POST, so the HTTP layer
// classifies every ordinary MDX *read* as a mutation. Before this filter a
// single tm1_execute_mdx call threw away the whole callgraph index and forced
// a full rebuild on the next analysis call.
//
// Deliberately an allowlist of known-inert paths, not a denylist of
// code-relevant ones: anything unrecognised keeps invalidating, so a new
// mutating endpoint is stale-safe by default.
const INERT_PATHS = [/\/ExecuteMDX/i, /\/Cellsets/i, /tm1\.Update/i];

function affectsReferenceGraph(path: string): boolean {
  return !INERT_PATHS.some((re) => re.test(path));
}

const invalidateOnMutation = (e: Tm1MutationEvent): void => {
  if (!affectsReferenceGraph(e.path)) return;
  invalidateCallgraphCache();
};

/**
 * Wire the callgraph reference-index cache to tm1Events "mutation" notifications:
 * any successful mutating HTTP call clears the cache so the next callgraph read
 * rebuilds from fresh server state. The HTTP layer stays decoupled — it only
 * emits the event; it holds no direct import of callgraph internals.
 *
 * Idempotent: safe to call once per TM1Client construction (or repeatedly)
 * without stacking duplicate listeners on the process-global emitter.
 */
export function registerCallgraphCacheInvalidation(): void {
  if (tm1Events.listeners("mutation").includes(invalidateOnMutation)) return;
  tm1Events.on("mutation", invalidateOnMutation);
}

export interface BuildIndexOpts {
  includeControl?: boolean;
  /** Force a fresh fetch and ignore cache. */
  bypassCache?: boolean;
}

interface CacheEntry {
  index: ReferenceIndex;
  ts: number;
  buildMs: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ReferenceIndex>>();

// Monotonic counter bumped on every invalidation. Clearing `cache` alone is not
// enough: a build that was already in flight when the mutation landed would
// finish afterwards and write its PRE-mutation snapshot back with a FRESH
// timestamp, republishing stale data for a full TTL. The build captures the
// generation it started in and refuses to publish if that generation is gone.
//
// The in-flight caller still receives the index it asked for — it requested a
// read that started before the mutation, so that result is merely old, not
// wrong. What must not happen is that snapshot becoming the answer for everyone
// else for the next 60 seconds.
let generation = 0;

export function invalidateCallgraphCache(): { cleared: number } {
  const n = cache.size;
  cache.clear();
  generation++;
  return { cleared: n };
}

export function getCallgraphCacheStats(): Array<{
  key: string;
  ageMs: number;
  ttlRemainingMs: number;
  buildMs: number;
}> {
  const now = Date.now();
  return Array.from(cache.entries()).map(([key, e]) => ({
    key,
    ageMs: now - e.ts,
    ttlRemainingMs: Math.max(0, CACHE_TTL_MS - (now - e.ts)),
    buildMs: e.buildMs,
  }));
}

/**
 * Build a full ReferenceIndex from a connected TM1 server.
 * TTL-cached (60 s) per `includeControl` flag. Concurrent calls share one inflight promise.
 */
export async function buildIndexFromTM1(
  tm1Client: TM1Client,
  opts: BuildIndexOpts = {},
): Promise<ReferenceIndex> {
  const includeControl = opts.includeControl ?? false;
  const key = `inc=${includeControl}`;

  if (!opts.bypassCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.index;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const promise = (async (): Promise<ReferenceIndex> => {
    const start = Date.now();
    const startGeneration = generation;
    const idx = await buildIndexInternal(tm1Client, includeControl);
    // Only publish if no invalidation happened while we were building.
    if (generation === startGeneration) {
      cache.set(key, {
        index: idx,
        ts: Date.now(),
        buildMs: Date.now() - start,
      });
    }
    return idx;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function buildIndexInternal(
  tm1Client: TM1Client,
  includeControl: boolean,
): Promise<ReferenceIndex> {
  const fetchProcesses = async (): Promise<ProcessFetchResult[]> => {
    const all = await tm1Client.processes.fetchForCallgraph(includeControl);
    return all.map((p) => ({
      name: p.name,
      prolog: p.prolog,
      metadata: p.metadata,
      data: p.data,
      epilog: p.epilog,
      parameters: p.parameters,
      parameterDefaults: p.parameterDefaults,
    }));
  };

  const fetchCubesWithRules = async (): Promise<CubeRulesFetchResult[]> => {
    const all = await tm1Client.cubes.getAllRules(includeControl);
    return all.map((c) => ({ cubeName: c.cubeName, rulesText: c.rulesText }));
  };

  const fetchChores = async (): Promise<ChoreFetchResult[]> => {
    try {
      const chs = await tm1Client.chores.list();
      return chs
        .filter((c) => includeControl || !c.name.startsWith("}"))
        .map((c) => {
          const tasks: ChoreTaskRef[] = c.processes.map((t, i) => ({
            step: i,
            processName: t.name,
            params: Object.entries(t.parameters).map(([name, val]) => ({
              name,
              value: String(val),
              type: typeof val === "number" ? "numeric" : "string",
            })),
          }));
          return { name: c.name, tasks };
        });
    } catch (e) {
      // Don't let an auth/connection/lock failure masquerade as "no chores" —
      // that silently drops chore→process edges from the callgraph and the
      // result looks complete. Real outages must propagate so the index is
      // not built (and cached) from partial data.
      rethrowIfSystemic(e);
      return [];
    }
  };

  return buildReferenceIndex({
    fetchProcesses,
    fetchCubesWithRules,
    fetchChores,
  });
}
