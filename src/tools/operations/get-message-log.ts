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
      const entries = await tm1Client.server.getMessageLog(top);
      const filtered = filter
        ? entries.filter((e) => e.message.toLowerCase().includes(filter.toLowerCase()))
        : entries;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ count: filtered.length, entries: filtered }, null, 2),
        }],
      };
    },
  );
}
