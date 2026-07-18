// Pure data-flow tracer for tm1_trace_data_flow. No I/O.
//
// Combines the reference index (code-level CellGet/CellPut/DB cube access,
// already classified read/write) with a per-process datasource list (to catch
// reads that flow through a TM1CubeView datasource and leave no CellGet in the
// code). Answers, for one cube:
//   downstream — processes that READ it, and which cubes they WRITE to.
//   upstream   — processes that WRITE it, and where they SOURCE their data.

import { elementKey, type ReferenceIndex } from "./referenceIndex.js";
import { classifyAccess } from "./callGraph.js";

export interface DataSourceEntry {
  name: string;
  type: string; // None | TM1CubeView | TM1DimensionSubset | ASCII | ODBC | TM1Process
  sourceName?: string | undefined; // dataSourceNameForServer (source cube/process for TM1CubeView/TM1Process)
  view?: string | undefined;
  subset?: string | undefined;
}

export type Direction = "upstream" | "downstream" | "both";

export interface UpstreamWriter {
  process: string;
  /** Cubes this writer reads from (code reads + a TM1CubeView datasource cube). */
  sourceCubes: string[];
  /** This writer's datasource type (where it pulls rows from). */
  datasourceType: string;
  /** For non-cube datasources (ASCII/ODBC/TM1Process/subset): a short source label. */
  externalSource?: string;
  /** In-code subset-membership elements this process manipulates (SubsetElementInsert/Add/Delete). */
  elements?: string[];
}

export interface DownstreamReader {
  process: string;
  /** Cubes this reader writes into. */
  targetCubes: string[];
  /** How the reader accesses the cube: code CellGet, a view datasource, or both. */
  readsVia: "code" | "datasource" | "both";
  /** In-code subset-membership elements this process manipulates (SubsetElementInsert/Add/Delete). */
  elements?: string[];
}

export interface DataFlowResult {
  cube: string;
  direction: Direction;
  upstream?: UpstreamWriter[];
  downstream?: DownstreamReader[];
  /** Present only when an element filter was supplied — processes that touch element (dimension, name). */
  element?: {
    dimension: string;
    name: string;
    processes: Array<{ process: string; funcNames: string[] }>;
    /** Processes where this dimension has an UNRESOLVED element arg (element identity not statically known). */
    unresolvedInProcesses?: string[];
    /** Honesty marker: what element resolution this result covers. */
    resolution: string;
  };
  counts: { upstream?: number; downstream?: number };
}

interface ProcessIO {
  orig: string;
  reads: Set<string>; // lowercased cube names
  writes: Set<string>; // lowercased cube names
  readsViaCode: boolean;
  readsViaDatasource: boolean;
  dsType: string;
  /** Lowercased source cube from a TM1CubeView datasource, if any. */
  dsSourceCube?: string;
  /** Label for a non-cube datasource. */
  externalSource?: string;
}

const lc = (s: string): string => s.toLowerCase();

/** Build per-process cube read/write sets from the index + datasource list. */
function buildProcessIO(
  index: ReferenceIndex,
  dsList: DataSourceEntry[],
  cubeOrig: Map<string, string>,
): Map<string, ProcessIO> {
  const io = new Map<string, ProcessIO>();
  const get = (name: string): ProcessIO => {
    const key = lc(name);
    let e = io.get(key);
    if (!e) {
      e = {
        orig: name,
        reads: new Set(),
        writes: new Set(),
        readsViaCode: false,
        readsViaDatasource: false,
        dsType: "None",
      };
      io.set(key, e);
    }
    return e;
  };

  // Datasource pass: every process, even ones with no cube code-refs.
  for (const ds of dsList) {
    const e = get(ds.name);
    e.dsType = ds.type;
    if (ds.type === "TM1CubeView" && ds.sourceName) {
      const cubeLc = lc(ds.sourceName);
      e.reads.add(cubeLc);
      e.readsViaDatasource = true;
      e.dsSourceCube = cubeLc;
      if (!cubeOrig.has(cubeLc)) cubeOrig.set(cubeLc, ds.sourceName);
    } else if (ds.type === "ASCII") {
      e.externalSource = "ASCII file";
    } else if (ds.type === "ODBC") {
      e.externalSource = "ODBC";
    } else if (ds.type === "TM1Process" && ds.sourceName) {
      e.externalSource = `process:${ds.sourceName}`;
    } else if (ds.type === "TM1DimensionSubset" && ds.sourceName) {
      e.externalSource = `subset:${ds.sourceName}`;
    }
  }

  // Code pass: classified cube reads/writes from the reference index.
  for (const r of index.all) {
    if (r.sourceKind !== "process" || r.targetKind !== "cube") continue;
    const access = classifyAccess(r.funcName, "process");
    if (access === "other") continue;
    const e = get(r.sourceName);
    const cubeLc = lc(r.targetName);
    if (!cubeOrig.has(cubeLc)) cubeOrig.set(cubeLc, r.targetName);
    if (access === "read") {
      e.reads.add(cubeLc);
      e.readsViaCode = true;
    } else {
      e.writes.add(cubeLc);
    }
  }

  return io;
}

/** In-code subset-membership element names a process manipulates, sorted & de-duped. */
function elementsForProcess(index: ReferenceIndex, processOrig: string): string[] {
  const refs = index.bySourceProcess.get(processOrig.toLowerCase()) ?? [];
  const names = new Set<string>();
  for (const r of refs) { if (r.targetKind === "element") names.add(r.targetName); }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Trace data flow into/out of a cube. Case-insensitive cube matching; output
 * preserves original casing. Lists are sorted by process name.
 */
export function traceDataFlow(
  index: ReferenceIndex,
  dsList: DataSourceEntry[],
  cubeName: string,
  direction: Direction,
  opts?: { element?: { dimension: string; name: string } },
): DataFlowResult {
  const cubeOrig = new Map<string, string>();
  const io = buildProcessIO(index, dsList, cubeOrig);
  const targetLc = lc(cubeName);
  const canonical = cubeOrig.get(targetLc) ?? cubeName;
  const cubeLabel = (l: string): string => cubeOrig.get(l) ?? l;

  const result: DataFlowResult = { cube: canonical, direction, counts: {} };

  if (direction === "downstream" || direction === "both") {
    const readers: DownstreamReader[] = [];
    for (const e of io.values()) {
      if (!e.reads.has(targetLc)) continue;
      const targetCubes = [...e.writes]
        .filter((c) => c !== targetLc)
        .map(cubeLabel)
        .sort((a, b) => a.localeCompare(b));
      const readsVia: DownstreamReader["readsVia"] =
        e.readsViaCode && e.readsViaDatasource ? "both" : e.readsViaCode ? "code" : "datasource";
      const elements = elementsForProcess(index, e.orig);
      readers.push({ process: e.orig, targetCubes, readsVia, ...(elements.length ? { elements } : {}) });
    }
    readers.sort((a, b) => a.process.localeCompare(b.process));
    result.downstream = readers;
    result.counts.downstream = readers.length;
  }

  if (direction === "upstream" || direction === "both") {
    const writers: UpstreamWriter[] = [];
    for (const e of io.values()) {
      if (!e.writes.has(targetLc)) continue;
      const sourceCubes = [...e.reads]
        .filter((c) => c !== targetLc)
        .map(cubeLabel)
        .sort((a, b) => a.localeCompare(b));
      const elements = elementsForProcess(index, e.orig);
      writers.push({
        process: e.orig,
        sourceCubes,
        datasourceType: e.dsType,
        ...(e.externalSource ? { externalSource: e.externalSource } : {}),
        ...(elements.length ? { elements } : {}),
      });
    }
    writers.sort((a, b) => a.process.localeCompare(b.process));
    result.upstream = writers;
    result.counts.upstream = writers.length;
  }

  if (opts?.element) {
    const { dimension, name } = opts.element;
    const refs = index.byElement.get(elementKey(dimension, name)) ?? [];
    const byProc = new Map<string, Set<string>>();
    for (const r of refs) {
      const set = byProc.get(r.sourceName) ?? new Set<string>();
      if (r.funcName) set.add(r.funcName);
      byProc.set(r.sourceName, set);
    }
    const processes = [...byProc.entries()]
      .map(([process, fns]) => ({ process, funcNames: [...fns].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.process.localeCompare(b.process));
    const unresolvedInProcesses = [...index.unresolvedElementRefsBySourceProcess.entries()]
      .filter(([, list]) => list.some((u) => (u.dimension ?? "").toLowerCase() === dimension.toLowerCase()))
      .map(([proc]) => proc)
      .sort((a, b) => a.localeCompare(b));
    result.element = {
      dimension,
      name,
      processes,
      ...(unresolvedInProcesses.length ? { unresolvedInProcesses } : {}),
      resolution:
        "in-code subset-membership calls only; elements reached through stored view/subset datasources are not resolved (Bucket B pending)",
    };
  }

  return result;
}
