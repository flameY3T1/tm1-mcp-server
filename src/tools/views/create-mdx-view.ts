import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCreateMdxView(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_mdx_view",
    "Create a public MDX-based view on a cube. The view persists server-side and can be used as a TI process datasource (TM1CubeView) or executed via tm1_get_view.",
    {
      cubeName: z.string().describe("Cube the view belongs to"),
      viewName: z.string().describe("New view name"),
      mdx: z.string().describe("MDX SELECT query defining the view"),
    },
    async ({ cubeName, viewName, mdx }) => {
      await tm1Client.createMdxView(cubeName, viewName, mdx);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, cubeName, viewName }, null, 2),
        }],
      };
    },
  );
}
