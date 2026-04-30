import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetCellValue(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_cell_value",
    "Get a single cell value from a TM1 cube by specifying element coordinates",
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      elements: z.array(z.string()).describe("Element names for each dimension of the cube"),
    },
    async ({ cubeName, elements }) => {
      try {
        const value = await tm1Client.getCellValue(cubeName, elements);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ value }, null, 2) }],
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
