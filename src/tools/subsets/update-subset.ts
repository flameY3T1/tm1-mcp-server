import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerUpdateSubset(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_subset",
    "Update a public TM1 subset (partial). Pass expression to replace the MDX, or elements to switch the subset to a static list (resets Expression to ''). Pass alias to change the alias attribute.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name"),
      subsetName: z.string().describe("Existing subset name"),
      expression: z.string().optional().describe("New MDX expression"),
      elements: z.array(z.string()).optional().describe("New static element list (clears MDX)"),
      alias: z.string().optional().describe("New alias attribute"),
    },
    async ({ dimensionName, hierarchyName, subsetName, expression, elements, alias }) => {
      await tm1Client.subsets.update(dimensionName, hierarchyName, subsetName, {
        expression,
        elements,
        alias,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, subsetName }) }],
      };
    },
  );
}
