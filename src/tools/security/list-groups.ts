import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListGroups(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_groups",
    "List TM1 groups. Defaults return Name + Clients[] (member usernames). Use compact=true to replace Clients[] with an integer clientCount — large savings when groups have many members.",
    {
      ...PAGINATION_SCHEMA,
      compact: z
        .boolean()
        .optional()
        .describe(
          "If true, replace Clients[] with clientCount: number on each group. Use for audits where membership names aren't needed.",
        ),
    },
    async ({ limit, offset, fetchAll, compact }) => {
      const groups = await tm1Client.security.listGroups();
      const page = paginate(groups, limit, offset, fetchAll);
      const items = compact
        ? page.items.map(({ Clients, ...rest }) => ({
            ...rest,
            clientCount: Clients?.length ?? 0,
          }))
        : page.items;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...page, items }, null, 2),
        }],
      };
    },
  );
}
