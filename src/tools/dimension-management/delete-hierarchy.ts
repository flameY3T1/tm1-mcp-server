import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteHierarchy(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_hierarchy",
    "Delete a hierarchy from a dimension. The default (dimension-named) hierarchy cannot be deleted — use tm1_delete_dimension for that.",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name to delete"),
    },
    async ({ dimensionName, hierarchyName }) => {
      await tm1Client.hierarchies.delete(dimensionName, hierarchyName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName, hierarchyName }, null, 2),
        }],
      };
    },
  );
}
