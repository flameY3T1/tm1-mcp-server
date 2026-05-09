import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListSubsets(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_subsets",
    "List public + private subsets of a TM1 hierarchy. Returns names, scope (public/private), MDX expression preview, and alias. Paginated (default 50/page).",
    {
      dimensionName: z.string().describe("Dimension name"),
      hierarchyName: z.string().describe("Hierarchy name (commonly equal to the dimension name)"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, limit, offset, fetchAll, format }) => {
      const subsets = await tm1Client.subsets.list(dimensionName, hierarchyName);
      const page = paginate(subsets, limit, offset, fetchAll);
      type Row = (typeof subsets)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (s) => s.name },
        { header: "scope", get: (s) => (s.private ? "private" : "public") },
        { header: "alias", get: (s) => s.alias ?? "" },
        { header: "expression", get: (s) => s.expression ?? "" },
      ];
      return pageResponse(page, format, { title: `Subsets of ${dimensionName}/${hierarchyName}`, columns });
    },
  );
}
