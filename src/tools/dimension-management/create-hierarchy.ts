import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCreateHierarchy(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_hierarchy",
    "Create a new (alternate) hierarchy inside an existing dimension. The dimension's default hierarchy already has the same name as the dimension — use this for additional rollup structures.",
    {
      dimensionName: z.string().describe("Existing dimension name"),
      hierarchyName: z.string().describe("New hierarchy name (must differ from existing hierarchies)"),
    },
    async ({ dimensionName, hierarchyName }) => {
      await tm1Client.createHierarchy(dimensionName, hierarchyName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName, hierarchyName }, null, 2),
        }],
      };
    },
  );
}
