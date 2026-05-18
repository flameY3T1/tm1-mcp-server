/**
 * Cross-process consistency metrics. Focus: naming + structure coherence
 * across many TI processes, not per-process micro-metrics.
 *
 * Premise: variability across processes is the maintenance cost driver, not
 * raw counts. A 200-line process with idiosyncratic naming hurts more than a
 * 1000-line process that follows the same patterns as its 50 siblings.
 */
import type { TiTab } from "./process-metrics.js";

export type VarType = "String" | "Numeric";

export interface ProcessVarInput {
  process: string;
  variables: Array<{ name: string; type: VarType }>;
}

/** ── 1) Variable-name clusters ──────────────────────────────────────────── */

export interface NameCluster {
  /** Canonical key (prefix-stripped, lowercased). */
  normalized: string;
  /** Original distinct variants encountered across processes. */
  variants: string[];
  /** Process names that contain at least one of the variants. */
  processes: string[];
}

const PREFIX_RE = /^[pvns](?=[A-Z_])/;

/**
 * Normalize: strip a single leading [pvns] when followed by uppercase/underscore,
 * strip underscores, lowercase. So `pYear`, `vYear`, `Year`, `p_year` all map
 * to `year`. Names like `p` or `value` stay as-is (no prefix match).
 */
export function normalizeVarName(raw: string): string {
  const stripped = raw.replace(PREFIX_RE, "");
  return stripped.replace(/_/g, "").toLowerCase();
}

export function clusterVariableNames(processes: ProcessVarInput[]): NameCluster[] {
  const byKey = new Map<
    string,
    { variants: Set<string>; processes: Set<string> }
  >();
  for (const p of processes) {
    for (const v of p.variables) {
      const key = normalizeVarName(v.name);
      let bucket = byKey.get(key);
      if (!bucket) {
        bucket = { variants: new Set(), processes: new Set() };
        byKey.set(key, bucket);
      }
      bucket.variants.add(v.name);
      bucket.processes.add(p.process);
    }
  }
  const out: NameCluster[] = [];
  for (const [normalized, b] of byKey) {
    if (b.variants.size > 1) {
      out.push({
        normalized,
        variants: [...b.variants].sort(),
        processes: [...b.processes].sort(),
      });
    }
  }
  return out.sort((a, b) => b.variants.length - a.variants.length);
}

/** ── 2) Type inconsistencies ─────────────────────────────────────────────── */

export interface TypeConflict {
  variable: string;
  /** Per-type list of processes declaring that name with that type. */
  occurrences: Array<{ type: VarType; processes: string[] }>;
}

export function findTypeInconsistencies(processes: ProcessVarInput[]): TypeConflict[] {
  const byName = new Map<string, Map<VarType, Set<string>>>();
  for (const p of processes) {
    for (const v of p.variables) {
      let typeMap = byName.get(v.name);
      if (!typeMap) {
        typeMap = new Map();
        byName.set(v.name, typeMap);
      }
      let procSet = typeMap.get(v.type);
      if (!procSet) {
        procSet = new Set();
        typeMap.set(v.type, procSet);
      }
      procSet.add(p.process);
    }
  }
  const out: TypeConflict[] = [];
  for (const [variable, typeMap] of byName) {
    if (typeMap.size > 1) {
      const occurrences = [...typeMap.entries()]
        .map(([type, procSet]) => ({ type, processes: [...procSet].sort() }))
        .sort((a, b) => a.type.localeCompare(b.type));
      out.push({ variable, occurrences });
    }
  }
  return out.sort((a, b) => a.variable.localeCompare(b.variable));
}

/** ── 3) Prefix-convention adherence ─────────────────────────────────────── */

export type PrefixClass = "p" | "v" | "n" | "s" | "none";

export interface PrefixConventionReport {
  /** All non-"none" prefixes ranked by frequency. */
  distribution: Array<{ prefix: PrefixClass; count: number }>;
  /** Adherence to convention `[pvns]` followed by upper/underscore. 0..1. */
  adherence: number;
  /** Total variables sampled. */
  total: number;
  /** Variables that don't fit any [pvns] prefix. */
  unprefixed: number;
}

function classifyPrefix(name: string): PrefixClass {
  const m = PREFIX_RE.exec(name);
  return m ? (m[0] as PrefixClass) : "none";
}

export function reportPrefixConvention(processes: ProcessVarInput[]): PrefixConventionReport {
  const counts: Record<PrefixClass, number> = { p: 0, v: 0, n: 0, s: 0, none: 0 };
  let total = 0;
  for (const p of processes) {
    for (const v of p.variables) {
      counts[classifyPrefix(v.name)]++;
      total++;
    }
  }
  const distribution = (["p", "v", "n", "s"] as PrefixClass[])
    .map((prefix) => ({ prefix, count: counts[prefix] }))
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count);
  const prefixed = total - counts.none;
  const adherence = total === 0 ? 0 : prefixed / total;
  return { distribution, adherence, total, unprefixed: counts.none };
}

/** ── 4) Cohort grouping by name suffix ──────────────────────────────────── */

export interface CohortInput {
  process: string;
  /** Optional pre-computed per-tab LOC for structural comparison (future use). */
  tabLoc?: Record<TiTab, number>;
}

export interface Cohort {
  key: string;
  members: string[];
}

const COHORT_SUFFIX_RE = /[_-]([A-Za-z]+)$/;

/**
 * Group processes by trailing alpha token after `_` or `-`. So `Load_Sales`
 * and `Aggregate_Sales` cohort as `Sales`; `Daily_Load` and `Weekly_Load`
 * cohort as `Load`. Singleton cohorts are omitted.
 */
export function groupByCohort(processes: Array<{ process: string }>): Cohort[] {
  const map = new Map<string, string[]>();
  for (const p of processes) {
    const m = COHORT_SUFFIX_RE.exec(p.process);
    const key = m ? m[1]!.toLowerCase() : "_other";
    const arr = map.get(key) ?? [];
    arr.push(p.process);
    map.set(key, arr);
  }
  const out: Cohort[] = [];
  for (const [key, members] of map) {
    if (members.length >= 2) out.push({ key, members: members.sort() });
  }
  return out.sort((a, b) => b.members.length - a.members.length);
}
