import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerDeleteSubset(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_subset",
    "Delete a public TM1 subset. Fails if the subset is referenced by views/processes (404 if not found).",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name"),
      subsetName: z.string().describe("Subset to delete"),
    },
    async ({ dimensionName, hierarchyName, subsetName }) => {
      await tm1Client.deleteSubset(dimensionName, hierarchyName, subsetName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, subsetName }) }],
      };
    },
  );
}
