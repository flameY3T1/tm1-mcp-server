import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";
import { fetchCubeStats, type CubeStatsItem } from "../../lib/cube-stats/fetcher.js";

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
      ...FORMAT_SCHEMA,
    },
    async ({ cubeName, cubeNames, format }) => {
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
        targets.map((name) => fetchCubeStats(tm1Client, name)),
      );
      const items: CubeStatsItem[] = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        const err = r.reason;
        const msg = err instanceof TM1Error ? `${err.code}: ${err.message}` : String(err);
        return { cubeName: targets[i]!, raw: {}, error: msg };
      });

      const payload = { count: items.length, items };
      const columns: Column<CubeStatsItem>[] = [
        { header: "cube", get: (i) => i.cubeName },
        { header: "memoryTotal", get: (i) => i.memoryTotal ?? "" },
        { header: "populatedNumeric", get: (i) => i.populatedNumeric ?? "" },
        { header: "fedCells", get: (i) => i.fedCells ?? "" },
        { header: "feederEfficiency", get: (i) => i.feederEfficiency ?? "" },
        { header: "error", get: (i) => i.error ?? "" },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Cube stats\n\n${p.count} cubes\n\n${renderTable(p.items, columns)}`,
      );
    },
  );
}
