import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
export function registerDeleteElement(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_element",
    "Delete an element from a TM1 dimension hierarchy. Irreversible — pass confirm=<element name verbatim>.",
    {
      dimensionName: z.string().describe("Name of the dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy"),
      elementName: z.string().describe("Name of the element to delete"),
      ...CONFIRM_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, elementName, confirm }) => {
      requireConfirm(confirm, elementName, "element");
      await tm1Client.elements.delete(dimensionName, hierarchyName, elementName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, elementName }) }],
      };
    },
  );
}
