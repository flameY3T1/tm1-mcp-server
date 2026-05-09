import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerListErrorLogs(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_error_logs",
    "List TI process error log files on the TM1 server, newest first. Use to discover which logs exist before fetching content with tm1_get_error_log_content. Filename pattern: '<ProcessName>_<timestamp>.log'.",
    {
      processName: z.string().optional()
        .describe("Optional prefix filter — only logs whose filename starts with '<processName>_' are returned"),
      since: z.string().optional()
        .describe("Only logs with LastUpdated >= this ISO timestamp, e.g. '2026-05-01T00:00:00'"),
      top: z.number().int().min(1).max(500).optional().default(50)
        .describe("Max entries to return (default: 50, max: 500)"),
    },
    async ({ processName, since, top }) => {
      const files = await tm1Client.server.listErrorLogFiles({ processName, since, top });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: files.length, files }, null, 2),
        }],
      };
    },
  );
}
