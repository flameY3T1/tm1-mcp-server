import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
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
      await tm1Client.elements.move(dimensionName, hierarchyName, elementName, newParent, weight);
      return actionResponse({ success: true, elementName, newParent });
    },
  );
}
