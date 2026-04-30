import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

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
      try {
        for (const c of cells) {
          if (c.elements.length !== dimensions.length) {
            throw new TM1Error({
              code: "VALIDATION_ERROR",
              message: `Cell element count (${c.elements.length}) does not match dimension count (${dimensions.length})`,
            });
          }
        }
        await tm1Client.writeCells(cubeName, dimensions, cells);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, cellsWritten: cells.length }) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
