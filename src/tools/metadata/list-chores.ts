import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Chore } from "../../types.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

type ChoreCompact = {
  name: string;
  active: boolean;
  startTime: string;
  frequency: string;
  processCount: number;
};

export function registerListChores(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_chores",
    [
      "List chores in the TM1 server with schedule and assigned processes.",
      "Use compact=true to replace the full processes[] array with processCount (~5–10x payload shrink for chores with many steps).",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      compact: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace processes[] with processCount (default: false)."),
    },
    async ({ limit, offset, compact }) => {
      try {
        const chores = await tm1Client.getChores();
        const projected: Array<Chore | ChoreCompact> = compact
          ? chores.map((c): ChoreCompact => ({
              name: c.name,
              active: c.active,
              startTime: c.startTime,
              frequency: c.frequency,
              processCount: c.processes.length,
            }))
          : chores;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(paginate(projected, limit, offset), null, 2) }],
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
