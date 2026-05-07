import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetAncestors(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_ancestors",
    [
      "Get all ancestors of an element via parent-walk. Multi-parent safe: returns the unique flat ancestor set AND every distinct root-to-element path.",
      "Use to find roll-up paths or detect that an element rolls up to multiple consolidations (alternate hierarchies).",
      "Output: { element, ancestors: [{ name, level }], paths: [[ root, ..., element ]] }.",
    ].join(" "),
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Hierarchy within the dimension"),
      element: z.string().describe("Element whose ancestors are requested. Root elements return empty ancestors and a single self-only path."),
    },
    async ({ dimensionName, hierarchyName, element }) => {
      const result = await tm1Client.getAncestors(dimensionName, hierarchyName, element);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
