import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerMoveElement(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_move_element",
    "Move an element to a new parent within a TM1 dimension hierarchy",
    {
      dimensionName: z.string().describe("Name of the dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy"),
      elementName: z.string().describe("Name of the element to move"),
      newParent: z.string().describe("Name of the new parent element"),
      weight: z.number().optional().describe("Weight for the parent-child relationship (default: 1)"),
    },
    async ({ dimensionName, hierarchyName, elementName, newParent, weight }) => {
      try {
        await tm1Client.moveElement(dimensionName, hierarchyName, elementName, newParent, weight);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, elementName, newParent }) }],
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
