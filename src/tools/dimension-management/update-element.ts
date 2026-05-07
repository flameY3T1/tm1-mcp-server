import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
const updateSchema = z.object({
  newName: z.string().optional().describe("New name for the element"),
  type: z.enum(["Numeric", "String", "Consolidated"]).optional().describe("New element type"),
  components: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .optional()
    .describe("New child components for consolidated elements"),
});

export function registerUpdateElement(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_element",
    "Update an existing element in a TM1 dimension hierarchy (name, type, or components)",
    {
      dimensionName: z.string().describe("Name of the dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy"),
      elementName: z.string().describe("Current name of the element to update"),
      update: updateSchema.describe("Fields to update on the element"),
    },
    async ({ dimensionName, hierarchyName, elementName, update }) => {
      await tm1Client.updateElement(dimensionName, hierarchyName, elementName, update);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, elementName }) }],
      };
    },
  );
}
