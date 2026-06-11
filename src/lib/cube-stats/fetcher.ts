/**
 * Shared `}StatsByCube` fetcher.
 *
 * Reads one cube's perf metrics into a flat `{ measureName: value }` map
 * plus a typed projection over well-known measures. Used by both
 * `tm1_get_cube_stats` (read-tool) and `tm1_audit_feeders` (runtime mode).
 *
 * The MDX targets `}StatsByCube` (TM1 v11.8 layout verified live):
 *   cube dim    → `}PerfCubes`
 *   measure dim → `}StatsStatsByCube`
 *   time dim    → `}TimeIntervals` sliced on `LATEST` for the current snapshot
 * `TM1FILTERBYLEVEL` keeps only leaf measures.
 */
import type { TM1Client } from "../../tm1-client.js";

/** Server-side `}StatsByCube` measure labels mapped to stable typed fields. */
export const KNOWN_METRICS: Record<string, string> = {
  "Memory Used for Views": "memoryViews",
  "Memory Used for Input Data": "memoryInput",
  "Memory Used for Feeders": "memoryFeeders",
  "Memory Used for Calculations": "memoryCalculations",
  "Total Memory Used": "memoryTotal",
  "Number of Populated Numeric Cells": "populatedNumeric",
  "Number of Populated String Cells": "populatedString",
  "Number of Stored Calculated Cells": "storedCalculated",
  "Number of Stored Views": "storedViews",
  "Number of Fed Cells": "fedCells",
  "Steps of Average Calculation": "avgCalculationSteps",
  "Rule calculation cache miss rate": "cacheMissRate",
};

export interface CubeStatsItem {
  cubeName: string;
  raw: Record<string, number | null>;
  error?: string;
  feederEfficiency?: number;
  [k: string]: unknown;
}

export async function fetchCubeStats(
  tm1Client: TM1Client,
  cubeName: string,
): Promise<CubeStatsItem> {
  const safe = cubeName.replace(/]/g, "]]");
  const mdx = [
    "SELECT",
    `  {[}PerfCubes].[}PerfCubes].[${safe}]} ON 0,`,
    "  {TM1FILTERBYLEVEL({TM1SUBSETALL([}StatsStatsByCube].[}StatsStatsByCube])}, 0)} ON 1",
    "FROM [}StatsByCube]",
    "WHERE ([}TimeIntervals].[LATEST])",
  ].join("\n");

  const result = await tm1Client.cells.executeMdx(mdx);
  const raw: Record<string, number | null> = {};
  const tuples = result.axes[1]?.tuples ?? [];
  for (let i = 0; i < tuples.length; i++) {
    const memberName = tuples[i]!.members[0]?.name ?? `unknown_${i}`;
    const cell = result.cells[i];
    raw[memberName] = typeof cell?.value === "number" ? cell.value : null;
  }

  const item: CubeStatsItem = { cubeName, raw };
  for (const [src, target] of Object.entries(KNOWN_METRICS)) {
    const v = raw[src];
    if (typeof v === "number") item[target] = v;
  }

  // Derived metric: feederEfficiency = fedCells / populatedNumeric.
  const fed = item.fedCells;
  const populated = item.populatedNumeric;
  if (typeof fed === "number" && typeof populated === "number" && populated > 0) {
    item.feederEfficiency = Number((fed / populated).toFixed(3));
  }

  return item;
}

/**
 * Fed-to-populated ratio: `fedCells / populatedNumeric` — the community-
 * standard }StatsByCube overfeeding indicator (tm1forum t=13110, Cubewise).
 * Rule of thumb: ≥ 50× suspicious, ≥ 100× definite overfeeding. Returns
 * `null` when either input is missing or `populatedNumeric` is zero — a
 * cube fed purely cross-cube can legitimately hold no input data, so a
 * missing denominator is "insufficient signal", not overfeeding.
 */
export function computeFedToPopulatedRatio(stats: CubeStatsItem): number | null {
  const pop = stats.populatedNumeric;
  const fed = stats.fedCells;
  if (typeof pop !== "number" || typeof fed !== "number" || pop <= 0) return null;
  return fed / pop;
}

/**
 * Feeder-memory ratio: `memoryFeeders / memoryInput` — secondary overfeeding
 * signal (feeder flags dwarfing the data they feed from). No community
 * threshold established; reported as context only, never flagged.
 */
export function computeFeederMemoryRatio(stats: CubeStatsItem): number | null {
  const feeders = stats.memoryFeeders;
  const input = stats.memoryInput;
  if (typeof feeders !== "number" || typeof input !== "number" || input <= 0) return null;
  return feeders / input;
}
