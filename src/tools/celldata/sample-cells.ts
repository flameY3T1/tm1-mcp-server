import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import {
  buildSampleCellsMdx,
  transformSampleCells,
  type SampleCellFilter,
} from "../../lib/sample-cells.js";

const FilterValueSchema: z.ZodType<SampleCellFilter> = z.union([
  z.string(),
  z.array(z.string()).min(1),
]);

export function registerSampleCells(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_sample_cells",
    [
      "Return up to maxCells populated cells from a cube without guessing element coordinates.",
      "Internally builds a NON EMPTY CROSSJOIN MDX over the cube's dimensions and HEAD-limits it.",
      "Use filters to pin or constrain dimensions: a single string becomes a WHERE pin (cheaper),",
      "an array becomes an axis member set. Useful for sanity-checking after a clone, finding any",
      "non-zero cells, or debugging empty views. Default maxCells=5; set maxCells=0 for unlimited",
      "(WARNING: large cubes may return millions of cells — prefer filters first).",
    ].join(" "),
    {
      cubeName: z.string().describe("Cube to sample"),
      maxCells: z.number().int().min(0).optional().default(5).describe(
        "Max cells to return (default 5). 0 = no limit (unbounded; combine with filters).",
      ),
      filters: z.record(z.string(), FilterValueSchema).optional().describe(
        "Per-dimension filters. Single string → WHERE pin. Array of strings → axis member set. Keys must match cube dimension names.",
      ),
      axisDimension: z.string().optional().describe(
        "Dimension placed on COLUMNS (default: last dimension of the cube). Useful when the cube has a 'Measures'/'Account' dim that should drive columns.",
      ),
      leavesOnly: z.boolean().optional().default(true).describe(
        "If true (default), unfiltered dims are restricted to leaf members via TM1FILTERBYLEVEL([dim],0). Set false to include consolidations.",
      ),
    },
    async ({ cubeName, maxCells, filters, axisDimension, leavesOnly }) => {
      const startedAt = Date.now();
      try {
        const dimensions = await tm1Client.getCubeDimensionNames(cubeName);

        const built = buildSampleCellsMdx({
          cubeName,
          dimensions,
          maxCells: maxCells ?? 5,
          filters,
          axisDimension,
          leavesOnly: leavesOnly ?? true,
        });

        const result = await tm1Client.executeMdx(built.mdx);

        const whereCoords: Record<string, string> = {};
        if (filters) {
          for (const [dim, val] of Object.entries(filters)) {
            if (typeof val === "string") whereCoords[dim] = val;
          }
        }
        const cells = transformSampleCells({ result, whereCoords });

        const hint = cells.length === 0
          ? "No populated cells found — cube may be empty, all-consolidated, or current filters exclude data."
          : undefined;

        const elapsedMs = Date.now() - startedAt;
        const truncated = (maxCells ?? 5) > 0 && cells.length >= (maxCells ?? 5);

        const payload = {
          cubeName,
          count: cells.length,
          truncated,
          cells,
          filtersApplied: filters ?? {},
          axisDimension: built.columnDim,
          rowDims: built.rowDims,
          whereDims: built.whereDims,
          mdxUsed: built.mdx,
          elapsedMs,
          ...(hint ? { hint } : {}),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? {
                code: error.code,
                message: error.message,
                httpStatus: error.httpStatus,
                endpoint: error.endpoint,
              }
            : { error: error instanceof Error ? error.message : String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
