import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerGetThreads(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_threads",
    "List active threads on the TM1 server (running processes, chores, MDX queries, etc.). Paginated (default 50/page).",
    { ...PAGINATION_SCHEMA, ...FORMAT_SCHEMA },
    async ({ limit, offset, fetchAll, format }) => {
      const threads = await tm1Client.monitoring.getThreads();
      const page = paginate(threads, limit, offset, fetchAll);
      type Row = (typeof threads)[number];
      const columns: Column<Row>[] = [
        { header: "id", get: (t) => t.id },
        { header: "name", get: (t) => t.name },
        { header: "state", get: (t) => t.state },
        { header: "function", get: (t) => t.function },
        { header: "objectName", get: (t) => t.objectName },
      ];
      return pageResponse(page, format, { title: "Threads", columns });
    },
  );

  server.tool(
    "tm1_cancel_thread",
    "Cancel a running TM1 server thread by its ID. Use tm1_list_threads to find the ID.",
    {
      id: z.number().int().describe("Thread ID to cancel"),
    },
    async ({ id }) => {
      await tm1Client.monitoring.cancelThread(id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, threadId: id }, null, 2) }] };
    },
  );
}
