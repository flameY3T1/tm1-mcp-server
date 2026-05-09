import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListViews(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_views",
    "List public and private views defined on a cube. Returns view name, visibility, and MDX (when available). Paginated (default 50/page).",
    {
      cubeName: z.string().describe("Cube name"),
      ...PAGINATION_SCHEMA,
    },
    async ({ cubeName, limit, offset, fetchAll }) => {
      const views = await tm1Client.views.list(cubeName);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(paginate(views, limit, offset, fetchAll), null, 2),
        }],
      };
    },
  );
}
