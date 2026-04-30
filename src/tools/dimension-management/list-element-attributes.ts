import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListElementAttributes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_element_attributes",
    "List all element attribute definitions of a TM1 hierarchy with their types (Numeric/String/Alias). Useful to verify attribute schema before writing values or referencing them in rules (ATTRN/ATTRS).",
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy within the dimension"),
    },
    async ({ dimensionName, hierarchyName }) => {
      try {
        const attributes = await tm1Client.listElementAttributes(dimensionName, hierarchyName);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ attributes }, null, 2) }],
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
