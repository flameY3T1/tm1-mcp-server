import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetMessageLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_message_log",
    "Fetch recent TM1 server message log entries, newest first. Useful for debugging TI process errors.",
    {
      top: z.number().int().min(1).max(500).optional().default(100)
        .describe("Number of entries to fetch (default: 100, max: 500)"),
      filter: z.string().optional()
        .describe("Optional text filter — only entries containing this string are returned (case-insensitive)"),
      ...FORMAT_SCHEMA,
    },
    async ({ top, filter, format }) => {
      const entries = await tm1Client.server.getMessageLog(top);
      const filtered = filter
        ? entries.filter((e) => e.message.toLowerCase().includes(filter.toLowerCase()))
        : entries;
      const payload = { count: filtered.length, entries: filtered };
      type Row = (typeof filtered)[number];
      const columns: Column<Row>[] = [
        { header: "timestamp", get: (e) => e.timestamp },
        { header: "level", get: (e) => e.level },
        { header: "message", get: (e) => e.message },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Message log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
      );
    },
  );
}
