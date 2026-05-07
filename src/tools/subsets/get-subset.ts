import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetSubset(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_subset",
    "Get a single TM1 subset with its MDX expression (if any) and resolved element list. Use isPrivate=true for private subsets.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name"),
      subsetName: z.string().describe("Subset name"),
      isPrivate: z.boolean().optional().default(false).describe("Look up the subset in PrivateSubsets instead of public Subsets"),
    },
    async ({ dimensionName, hierarchyName, subsetName, isPrivate }) => {
      const subset = await tm1Client.getSubset(dimensionName, hierarchyName, subsetName, isPrivate ?? false);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(subset, null, 2) }],
      };
    },
  );
}
