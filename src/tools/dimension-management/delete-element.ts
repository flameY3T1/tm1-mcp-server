import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerDeleteElement(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_element",
    "Delete an element from a TM1 dimension hierarchy",
    {
      dimensionName: z.string().describe("Name of the dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy"),
      elementName: z.string().describe("Name of the element to delete"),
    },
    async ({ dimensionName, hierarchyName, elementName }) => {
      try {
        await tm1Client.deleteElement(dimensionName, hierarchyName, elementName);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, elementName }) }],
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
