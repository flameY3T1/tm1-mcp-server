import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetTransactionLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_transaction_log",
    "Fetch recent TM1 transaction log entries (cell writes), newest first. Optional filters: cube, user, since (ISO timestamp).",
    {
      top: z.number().int().min(1).max(1000).optional().default(100)
        .describe("Max entries to return (default: 100, max: 1000)"),
      cubeName: z.string().optional().describe("Filter to one cube"),
      user: z.string().optional().describe("Filter to one user"),
      since: z.string().optional()
        .describe("Only entries on or after this ISO timestamp, e.g. '2026-04-17T00:00:00'"),
    },
    async ({ top, cubeName, user, since }) => {
      try {
        const entries = await tm1Client.server.getTransactionLog({ top, cubeName, user, since });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ count: entries.length, entries }, null, 2),
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
