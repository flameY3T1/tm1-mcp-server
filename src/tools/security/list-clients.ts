import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListClients(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_clients",
    "List TM1 clients (users) with their group memberships. Returns name, friendly name, enabled state, and groups. Paginated (default 50/page).",
    { ...PAGINATION_SCHEMA },
    async ({ limit, offset, fetchAll }) => {
      try {
        const clients = await tm1Client.listClients();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(paginate(clients, limit, offset, fetchAll), null, 2),
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
