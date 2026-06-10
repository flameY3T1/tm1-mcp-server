import type { TM1Client } from "../../tm1-client.js";
import { buildReferenceIndex, type ReferenceIndex, type ProcessFetchResult, type CubeRulesFetchResult, type ChoreFetchResult, type ChoreTaskRef } from "./referenceIndex.js";
import { tm1Events } from "../tm1-events.js";

// Self-register: invalidate cache on any mutation so the HTTP layer
// does not need a direct import of callgraph internals.
tm1Events.on("mutation", () => { invalidateCallgraphCache(); });

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

export function invalidateCallgraphCache(): { cleared: number } {
  const n = cache.size;
  cache.clear();
  return { cleared: n };
}

export function getCallgraphCacheStats(): Array<{ key: string; ageMs: number; ttlRemainingMs: number; buildMs: number }> {
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
export async function buildIndexFromTM1(tm1Client: TM1Client, opts: BuildIndexOpts = {}): Promise<ReferenceIndex> {
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
    const idx = await buildIndexInternal(tm1Client, includeControl);
    cache.set(key, { index: idx, ts: Date.now(), buildMs: Date.now() - start });
    return idx;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function buildIndexInternal(tm1Client: TM1Client, includeControl: boolean): Promise<ReferenceIndex> {

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
    } catch {
      return [];
    }
  };

  return buildReferenceIndex({ fetchProcesses, fetchCubesWithRules, fetchChores });
}
