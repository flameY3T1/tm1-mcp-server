import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListGroups(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_groups",
    "List TM1 groups with assigned client names. Paginated (default 50/page).",
    { ...PAGINATION_SCHEMA },
    async ({ limit, offset }) => {
      try {
        const groups = await tm1Client.listGroups();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(paginate(groups, limit, offset), null, 2),
          }],
        };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
