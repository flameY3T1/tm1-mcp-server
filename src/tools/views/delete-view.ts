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
      try {
        await tm1Client.deleteView(cubeName, viewName);
        return { content: [{ type: "text", text: `View "${viewName}" deleted from cube "${cubeName}".` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
