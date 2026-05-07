import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetDescendants(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_descendants",
    [
      "Get descendants of a consolidation element. Token-efficient alternative to tm1_get_hierarchy when you only need a subtree.",
      "depth caps how many levels below the start element are returned (depth=1 = direct children).",
      "leavesOnly=true keeps only N-elements (no consolidations). Multi-parent hierarchies: each unique element appears once.",
      "Output: { element, descendants: [{ name, type, level, depth }] }.",
    ].join(" "),
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Hierarchy within the dimension"),
      element: z.string().describe("Start element (typically a consolidation). Numeric/leaf elements return empty descendants."),
      depth: z.number().int().positive().optional()
        .describe("Max depth below the start element. Omit for unlimited."),
      leavesOnly: z.boolean().optional().default(false)
        .describe("Return only leaf elements (no consolidations)."),
    },
    async ({ dimensionName, hierarchyName, element, depth, leavesOnly }) => {
      const result = await tm1Client.getDescendants(dimensionName, hierarchyName, element, {
        ...(depth !== undefined ? { depth } : {}),
        ...(leavesOnly !== undefined ? { leavesOnly } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
