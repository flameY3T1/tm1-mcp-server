import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetTransactionLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_transaction_log",
    "Fetch recent TM1 transaction log entries (cell writes), newest first. Optional filters: cube, user, since. NOTE: this endpoint scans the whole log server-side and is slow — a cheap preflight probe runs first to fail fast if it is unreachable or you lack rights; pass `since` to bound the scan.",
    {
      top: z.number().int().min(1).max(1000).optional().default(100)
        .describe("Max entries to return (default: 100, max: 1000)"),
      cubeName: z.string().optional().describe("Filter to one cube"),
      user: z.string().optional().describe("Filter to one user"),
      since: z.string().optional()
        .describe("Only entries on or after this timestamp, interpreted as UTC. Accepts a date '2026-04-17' or datetime '2026-04-17T00:00:00' (a 'Z'/offset is added if missing). Strongly recommended to bound the otherwise-slow full-log scan."),
      ...FORMAT_SCHEMA,
    },
    async ({ top, cubeName, user, since, format }) => {
      const entries = await tm1Client.server.getTransactionLog({ top, cubeName, user, since });
      const payload = { count: entries.length, entries };
      type Row = (typeof entries)[number];
      const columns: Column<Row>[] = [
        { header: "timestamp", get: (e) => e.timestamp },
        { header: "user", get: (e) => e.user },
        { header: "cube", get: (e) => e.cubeName },
        { header: "elements", get: (e) => e.elements },
        { header: "old", get: (e) => e.oldValue },
        { header: "new", get: (e) => e.newValue },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Transaction log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
      );
    },
  );
}
