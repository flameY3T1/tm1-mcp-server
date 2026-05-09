import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListViews(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_views",
    "List public and private views defined on a cube. Returns view name, visibility, and MDX (when available). Paginated (default 50/page).",
    {
      cubeName: z.string().describe("Cube name"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ cubeName, limit, offset, fetchAll, format }) => {
      const views = await tm1Client.views.list(cubeName);
      const page = paginate(views, limit, offset, fetchAll);
      type Row = (typeof views)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (v) => v.name },
        { header: "scope", get: (v) => (v.private ? "private" : "public") },
        { header: "mdx", get: (v) => v.mdx ?? "" },
      ];
      return pageResponse(page, format, { title: `Views of ${cubeName}`, columns });
    },
  );
}
