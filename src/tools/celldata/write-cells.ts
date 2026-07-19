import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { actionResponse } from "../format.js";

export function registerWriteCells(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_write_cells",
    [
      "Write one or more cell values directly to a TM1 cube via REST.",
      "IMPORTANT: TI processes are the standard path for data loads — use this tool only for ad-hoc writes or when explicitly requested.",
      "Writes to consolidated cells are rejected by TM1.",
      "Before: tm1_check_writable_coords to validate that target coordinates are leaf-level and addressable.",
      "Related: tm1_clear_cube for bulk wipe, tm1_get_cell_value to read back, tm1_execute_process for production data loads.",
    ].join(" "),
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
      // writeCells throws a TM1Error carrying its own partial-commit accounting
      // (written / failed / notAttempted) + a targeted hint, so we let it
      // propagate to the index.ts Proxy unwrapped — wrapping it here would
      // clobber that hint with a generic one.
      await tm1Client.cells.writeCells(cubeName, dimensions, cells);
      return actionResponse({ success: true, cellsWritten: cells.length });
    },
  );
}
