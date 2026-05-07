import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListSubsets(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_subsets",
    "List public + private subsets of a TM1 hierarchy. Returns names, scope (public/private), MDX expression preview, and alias. Paginated (default 50/page).",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name (commonly equal to the dimension name)"),
      ...PAGINATION_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, limit, offset, fetchAll }) => {
      const subsets = await tm1Client.listSubsets(dimensionName, hierarchyName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(paginate(subsets, limit, offset, fetchAll), null, 2),
        }],
      };
    },
  );
}
