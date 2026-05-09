import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, payloadResponse, type Column } from "../format.js";

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
      compact: z.boolean().optional().default(false)
        .describe("Return summary only: { total, namedUsers, anonymousCount }. Skips pagination and per-session detail. Useful for a quick headcount without flooding context."),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ activeOnly, withThreads, compact, limit, offset, fetchAll, format }) => {
      const sessions = await tm1Client.monitoring.getSessions();
      const filtered = activeOnly ? sessions.filter((s) => s.active !== false) : sessions;
      if (compact) {
        const namedUsers = filtered.filter((s) => s.user && s.user.trim() !== "").length;
        const summary = {
          total: filtered.length,
          count: 0,
          offset: 0,
          has_more: false,
          next_offset: null,
          items: [],
          summary: { namedUsers, anonymousCount: filtered.length - namedUsers },
        };
        return payloadResponse(summary, format, (p) =>
          `## Sessions (compact)\n\n${p.total} total · ${p.summary.namedUsers} named users · ${p.summary.anonymousCount} anonymous`,
        );
      }
      const projected = withThreads
        ? filtered
        : filtered.map((s) => ({ ...s, threads: [] }));
      const page = paginate(projected, limit, offset, fetchAll);
      type Row = (typeof projected)[number];
      const columns: Column<Row>[] = [
        { header: "id", get: (s) => s.id },
        { header: "user", get: (s) => s.user ?? "" },
        { header: "active", get: (s) => s.active ?? "" },
        { header: "threads", get: (s) => s.threads?.length ?? 0 },
      ];
      return pageResponse(page, format, { title: "Sessions", columns });
    },
  );
}
