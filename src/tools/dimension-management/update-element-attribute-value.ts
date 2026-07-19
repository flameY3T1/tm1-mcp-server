import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
export function registerUpdateElementAttributeValue(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_element_attribute_value",
    "Set a single attribute value on an element by writing to the }ElementAttributes_{Dim} control cube. For reproducible deployments prefer a TI process (CellPutS / CellPutN / AttrPutS / AttrPutN). Use this REST-direct tool for ad-hoc / debugging scenarios.",
    {
      dimensionName: z.string().describe("Dimension name"),
      elementName: z.string().describe("Element whose attribute value should be set"),
      attributeName: z.string().describe("Attribute name (must already exist as schema)"),
      value: z.union([z.string(), z.number()]).describe("New value (string for String/Alias attributes, number for Numeric attributes)"),
    },
    async ({ dimensionName, elementName, attributeName, value }) => {
      await tm1Client.elements.updateAttributeValue(dimensionName, elementName, attributeName, value);
      return actionResponse({ success: true, dimensionName, elementName, attributeName, value });
    },
  );
}
