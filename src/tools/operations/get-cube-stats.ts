import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

// Maps server-side `}StatsByCube` measure-element labels (verified live on
// TM1 v11.8) to a stable typed field name on the response. Anything not
// listed here still flows through under the `raw` map, so v12 renames or new
// metrics never silently disappear — callers just read them by original name.
const KNOWN_METRICS: Record<string, string> = {
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

interface CubeStatsItem {
  cubeName: string;
  raw: Record<string, number | null>;
  error?: string;
  [k: string]: unknown;
}

async function fetchOne(tm1Client: TM1Client, cubeName: string): Promise<CubeStatsItem> {
  // }StatsByCube structure (verified live on TM1 v11.8):
  //   cube dim:    }PerfCubes
  //   measure dim: }StatsStatsByCube
  //   time dim:    }TimeIntervals (slice on LATEST for current snapshot)
  // TM1FILTERBYLEVEL keeps only leaf elements, skipping any consolidations.
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
    const memberName = tuples[i].members[0]?.name ?? `unknown_${i}`;
    const cell = result.cells[i];
    raw[memberName] = typeof cell?.value === "number" ? cell.value : null;
  }

  const item: CubeStatsItem = { cubeName, raw };
  for (const [src, target] of Object.entries(KNOWN_METRICS)) {
    const v = raw[src];
    if (typeof v === "number") item[target] = v;
  }

  // Derived metric: feederEfficiency = fedCells / populatedNumeric.
  // memoryTotal is read directly from "Total Memory Used" (not summed) so it
  // matches what TM1 reports.
  const fed = item.fedCells;
  const populated = item.populatedNumeric;
  if (typeof fed === "number" && typeof populated === "number" && populated > 0) {
    item.feederEfficiency = Number((fed / populated).toFixed(3));
  }

  return item;
}

export function registerGetCubeStats(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_cube_stats",
    [
      "Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency).",
      "Pass cubeName for a single cube or cubeNames for batch mode (parallel queries).",
      "Well-known metrics are mapped to typed fields; the full element-name → value map is also returned under `raw` so server-side renames don't break the tool.",
      "Per-cube errors are reported as items[].error without failing the whole call.",
    ].join(" "),
    {
      cubeName: z.string().optional()
        .describe("Single cube name. Mutually exclusive with cubeNames."),
      cubeNames: z.array(z.string()).min(1).optional()
        .describe("Batch mode — list of cube names. Mutually exclusive with cubeName."),
    },
    async ({ cubeName, cubeNames }) => {
      if (cubeName !== undefined && cubeNames !== undefined) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "cubeName and cubeNames are mutually exclusive — pass only one.",
            }),
          }],
          isError: true,
        };
      }
      const targets = cubeNames ?? (cubeName !== undefined ? [cubeName] : []);
      if (targets.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "Specify exactly one of cubeName or cubeNames.",
            }),
          }],
          isError: true,
        };
      }

      const settled = await Promise.allSettled(
        targets.map((name) => fetchOne(tm1Client, name)),
      );
      const items: CubeStatsItem[] = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const err = r.reason;
        const msg = err instanceof TM1Error ? `${err.code}: ${err.message}` : String(err);
        return { cubeName: targets[i], raw: {}, error: msg };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: items.length, items }, null, 2),
        }],
      };
    },
  );
}
