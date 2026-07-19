import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetMessageLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_message_log",
    "Fetch recent TM1 server message log entries, newest first. Useful for debugging TI process errors. The `filter`/`level`/`since` filters are applied SERVER-SIDE, so a matching entry is found even when it is older than the newest `top` rows (no false 'no error found'). When an entry references a TI error file, the parsed filename is surfaced as `errorFile` — pass it straight to tm1_get_error_log_content to read the failure detail.",
    {
      top: z.number().int().min(1).max(500).optional().default(100)
        .describe("Number of entries to fetch (default: 100, max: 500). Applied AFTER the filters, so a filter still finds older matches beyond the newest 500 rows."),
      filter: z.string().optional()
        .describe("Optional text filter — only entries whose message contains this string are returned (case-insensitive). Pushed to the server, so matches older than `top` are found."),
      level: z.string().optional()
        .describe("Optional exact level filter, e.g. 'ERROR', 'WARN', 'INFO'."),
      since: z.string().optional()
        .describe("Only entries on or after this timestamp (UTC). Date '2026-06-01' or datetime '2026-06-01T00:00:00' (a 'Z' is added if missing)."),
      until: z.string().optional()
        .describe("Only entries on or before this timestamp (UTC). Same format as since."),
      ...FORMAT_SCHEMA,
    },
    async ({ top, filter, level, since, until, format }) => {
      const filtered = await tm1Client.server.getMessageLog({ top, filter, level, since, until });
      const payload = { count: filtered.length, entries: filtered };
      type Row = (typeof filtered)[number];
      const columns: Column<Row>[] = [
        { header: "timestamp", get: (e) => e.timestamp },
        { header: "level", get: (e) => e.level },
        { header: "message", get: (e) => e.message },
        { header: "errorFile", get: (e) => e.errorFile ?? "" },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Message log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
      );
    },
  );
}
