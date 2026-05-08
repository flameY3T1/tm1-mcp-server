import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerCreateElementAttribute(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_element_attribute",
    "Create an element attribute definition (schema) on a TM1 hierarchy. For reproducible deployments prefer a TI process (DimensionElementInsert on the }ElementAttributes_{dim} control cube). Use this tool for ad-hoc / debugging scenarios or when explicitly requested.",
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy within the dimension"),
      attributeName: z.string().describe("Name of the new attribute"),
      attributeType: z.enum(["Numeric", "String", "Alias"]).describe("Attribute type: Numeric (ATTRN), String (ATTRS), or Alias"),
    },
    async ({ dimensionName, hierarchyName, attributeName, attributeType }) => {
      await tm1Client.elements.createAttribute(dimensionName, hierarchyName, attributeName, attributeType);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, attributeName, attributeType }) }],
      };
    },
  );
}
