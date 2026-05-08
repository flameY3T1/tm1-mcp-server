import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
const elementSchema = z.object({
  name: z.string().describe("Element name"),
  type: z.enum(["Numeric", "String", "Consolidated"]).describe("Element type"),
  components: z
    .array(z.object({ name: z.string(), weight: z.number() }))
    .optional()
    .describe("Child components for consolidated elements"),
});

export function registerCreateElement(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_element",
    "Create a new element in a TM1 dimension hierarchy",
    {
      dimensionName: z.string().describe("Name of the dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy"),
      element: elementSchema.describe("Element definition with name, type and optional components"),
    },
    async ({ dimensionName, hierarchyName, element }) => {
      await tm1Client.elements.create(dimensionName, hierarchyName, element);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, elementName: element.name }) }],
      };
    },
  );
}
