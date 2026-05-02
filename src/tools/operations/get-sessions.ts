import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerGetSessions(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_sessions",
    [
      "List active sessions on the TM1 server with their associated user and threads.",
      "Pair with tm1_list_threads / tm1_cancel_thread to see who is connected and what they are running.",
      "Paginated (default 50/page).",
    ].join(" "),
    {
      activeOnly: z.boolean().optional().default(false)
        .describe("If true, return only sessions flagged Active by the server (default: false — return all)"),
      withThreads: z.boolean().optional().default(true)
        .describe("Include thread details per session (default: true)"),
      ...PAGINATION_SCHEMA,
    },
    async ({ activeOnly, withThreads, limit, offset }) => {
      try {
        const sessions = await tm1Client.getSessions();
        const filtered = activeOnly ? sessions.filter((s) => s.active !== false) : sessions;
        const projected = withThreads
          ? filtered
          : filtered.map((s) => ({ ...s, threads: [] }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify(paginate(projected, limit, offset), null, 2),
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
