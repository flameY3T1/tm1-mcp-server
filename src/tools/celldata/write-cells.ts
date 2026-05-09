import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { withToolHint } from "../error-format.js";

export function registerWriteCells(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_write_cells",
    "Write one or more cell values directly to a TM1 cube via REST. IMPORTANT: TI processes are the standard path for data loads — use this tool only for ad-hoc writes or when explicitly requested. Each cell specifies element names in the cube's dimension order and a numeric or string value. Writes to consolidated cells are rejected by TM1.",
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      dimensions: z
        .array(z.string())
        .min(2)
        .describe("Cube dimension names in exact cube order (required because the element tuples use @odata.bind references)"),
      cells: z
        .array(
          z.object({
            elements: z.array(z.string()).describe("Element names, one per dimension, in the cube's dimension order"),
            value: z.union([z.number(), z.string()]).describe("Cell value (number for Numeric cubes, string for String cells)"),
          }),
        )
        .min(1)
        .describe("Cells to write"),
    },
    async ({ cubeName, dimensions, cells }) => {
      for (const c of cells) {
        if (c.elements.length !== dimensions.length) {
          throw new TM1Error({
            code: "VALIDATION_ERROR",
            message: `Cell element count (${c.elements.length}) does not match dimension count (${dimensions.length})`,
          });
        }
      }
      await withToolHint(
        tm1Client.cells.writeCells(cubeName, dimensions, cells),
        `Cell write rejected. Common causes: writing to a consolidated cell (only N-level allowed), or rule-derived cell (read-only). Run tm1_check_writable_coords(cubeName='${cubeName}', dimensions=..., cells=...) first to filter writable coords and detect rule-overlap warnings.`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, cellsWritten: cells.length }) }],
      };
    },
  );
}
