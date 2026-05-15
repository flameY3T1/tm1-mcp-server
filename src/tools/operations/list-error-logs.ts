import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListErrorLogs(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_error_logs",
    [
      "List TI process error log files on the TM1 server, newest first.",
      "Filename patterns: modern v11 'TM1ProcessError_<ts>_<id>_<proc>_<hash>.log' and legacy '<proc>_<ts>.log' (use processName to filter both).",
      "Paginated (default 50/page). For one-call diagnosis of a failed process prefer tm1_diagnose_process_error which combines list + fetch; use this tool when you need to browse the catalogue.",
      "Follow up with tm1_get_error_log_content for the raw log text.",
    ].join(" "),
    {
      processName: z.string().optional()
        .describe("Optional process-name filter — matches both modern v11 'TM1ProcessError_<ts>_<id>_<processName>_<hash>.log' and legacy '<processName>_<ts>.log' filename patterns."),
      since: z.string().optional()
        .describe("Only logs with LastUpdated >= this ISO timestamp, e.g. '2026-05-01T00:00:00'"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ processName, since, limit, offset, fetchAll, format }) => {
      // Pull a generous slice from the server (top=500); pagination is applied client-side
      // so callers always see total + has_more even if they limit to a small page.
      const files = await tm1Client.server.listErrorLogFiles({ processName, since, top: 500 });
      const page = paginate(files, limit, offset, fetchAll);
      type Row = (typeof files)[number];
      const columns: Column<Row>[] = [
        { header: "filename", get: (f) => f.filename },
        { header: "lastUpdated", get: (f) => f.lastUpdated ?? "" },
      ];
      return pageResponse(page, format, { title: "Error logs", columns });
    },
  );
}
