import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetMessageLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_message_log",
    "Fetch recent TM1 server message log entries, newest first. Useful for debugging TI process errors.",
    {
      top: z.number().int().min(1).max(500).optional().default(100)
        .describe("Number of entries to fetch (default: 100, max: 500)"),
      filter: z.string().optional()
        .describe("Optional text filter — only entries containing this string are returned (case-insensitive)"),
    },
    async ({ top, filter }) => {
      try {
        const entries = await tm1Client.getMessageLog(top);
        const filtered = filter
          ? entries.filter((e) => e.message.toLowerCase().includes(filter.toLowerCase()))
          : entries;

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: "No log entries found." }] };
        }

        const lines = filtered.map((e) => `[${e.timestamp}] [${e.level}] ${e.message}`);
        return {
          content: [{
            type: "text",
            text: `${filtered.length} log entr${filtered.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
