import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListProcesses(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_processes",
    "List TurboIntegrator processes in the TM1 server with their parameters. Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    { ...PAGINATION_SCHEMA },
    async ({ limit, offset }) => {
      try {
        const processes = await tm1Client.getProcesses();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(paginate(processes, limit, offset), null, 2) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
