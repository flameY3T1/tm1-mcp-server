import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteView(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_view",
    "Delete a public view from a cube.",
    {
      cubeName: z.string().describe("Cube name"),
      viewName: z.string().describe("View name to delete"),
    },
    async ({ cubeName, viewName }) => {
      await tm1Client.views.delete(cubeName, viewName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, cubeName, viewName }),
        }],
      };
    },
  );
}
