import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteDimension(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_dimension",
    "Delete a TM1 dimension and all its hierarchies. Warning: fails if the dimension is used in a cube.",
    {
      name: z.string().describe("Dimension name (case-sensitive)"),
    },
    async ({ name }) => {
      await tm1Client.dimensions.delete(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName: name }, null, 2),
        }],
      };
    },
  );
}
