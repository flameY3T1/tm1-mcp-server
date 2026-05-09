import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { tsFromFilename, truncateTail, tailLines } from "./error-log-helpers.js";

const DEFAULT_TAIL_LINES = 60;
const DEFAULT_MAX_LOGS = 3;
const DEFAULT_RELATED_WINDOW_SEC = 10;
const DEFAULT_RELATED_MAX_FILES = 5;
const DEFAULT_RELATED_MAX_BYTES = 16 * 1024;

export function registerDiagnoseProcessError(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_diagnose_process_error",
    [
      "One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content,",
      "and optionally includes cascade-related sibling logs (same timestamp window) in a single response.",
      "Replaces the manual sequence: tm1_list_error_logs → tm1_get_error_log_content (× N).",
      "Returns logs newest-first. Use since to narrow to a specific time window.",
    ].join(" "),
    {
      processName: z.string().describe("Process name to diagnose. Matches log files whose filename starts with '<processName>_'."),
      since: z.string().optional().describe("Only consider logs with LastUpdated >= this ISO timestamp, e.g. '2026-05-04T00:00:00'."),
      maxLogs: z.number().int().min(1).max(20).optional().default(DEFAULT_MAX_LOGS)
        .describe(`Max number of log files to fetch (newest first, default ${DEFAULT_MAX_LOGS}).`),
      tail: z.number().int().min(1).max(10000).optional().default(DEFAULT_TAIL_LINES)
        .describe(`Lines to return from the end of each log (default ${DEFAULT_TAIL_LINES}).`),
      includeRelated: z.boolean().optional().default(true)
        .describe("Also fetch sibling logs within ±relatedWindowSec of each log's timestamp (cascade failure tracing). Default: true."),
      relatedWindowSec: z.number().int().min(1).max(300).optional().default(DEFAULT_RELATED_WINDOW_SEC)
        .describe(`Time window in seconds for cascade log discovery (default ${DEFAULT_RELATED_WINDOW_SEC}).`),
      relatedMaxFiles: z.number().int().min(1).max(20).optional().default(DEFAULT_RELATED_MAX_FILES)
        .describe(`Max related logs per primary log (default ${DEFAULT_RELATED_MAX_FILES}).`),
    },
    async ({ processName, since, maxLogs, tail, includeRelated, relatedWindowSec, relatedMaxFiles }) => {
      const allFiles = await tm1Client.server.listErrorLogFiles({ top: 500 });
      const matching = allFiles
        .filter((f) => f.filename.toLowerCase().startsWith(processName.toLowerCase() + "_"))
        .filter((f) => {
          if (!since) return true;
          return !f.lastUpdated || f.lastUpdated >= since;
        })
        .slice(0, maxLogs);

      if (matching.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ processName, since, logsFound: 0, logsReturned: 0, logs: [] }, null, 2),
          }],
        };
      }

      const windowMs = relatedWindowSec * 1000;

      const logs = await Promise.all(matching.map(async (f) => {
        let content = "";
        let fetchError: string | undefined;
        let truncated = false;
        let totalLines = 0;

        try {
          const raw = await tm1Client.server.getErrorLogContent(f.filename);
          const result = tailLines(raw, tail);
          content = result.body;
          truncated = result.truncated;
          totalLines = result.totalLines;
        } catch (e) {
          fetchError = (e as Error).message;
        }

        const entry: Record<string, unknown> = {
          filename: f.filename,
          lastUpdated: f.lastUpdated,
          totalLines,
          truncated,
          ...(fetchError ? { fetchError } : { content }),
        };

        if (includeRelated) {
          const sourceTs = tsFromFilename(f.filename);
          if (sourceTs === null) {
            entry.related = { note: "No embedded timestamp — cascade lookup skipped.", files: [] };
          } else {
            const candidates = allFiles
              .filter((r) => r.filename !== f.filename)
              .map((r) => ({ filename: r.filename, ts: tsFromFilename(r.filename) }))
              .filter((r): r is { filename: string; ts: number } => r.ts !== null)
              .filter((r) => Math.abs(r.ts - sourceTs) <= windowMs)
              .sort((a, b) => Math.abs(a.ts - sourceTs) - Math.abs(b.ts - sourceTs))
              .slice(0, relatedMaxFiles);

            const related = await Promise.all(candidates.map(async ({ filename: rf, ts }) => {
              try {
                const raw = await tm1Client.server.getErrorLogContent(rf);
                const { body, truncated: rt } = truncateTail(raw, DEFAULT_RELATED_MAX_BYTES);
                return { filename: rf, deltaSec: Math.round((ts - sourceTs) / 1000), truncated: rt, content: body };
              } catch (e) {
                return { filename: rf, deltaSec: Math.round((ts - sourceTs) / 1000), fetchError: (e as Error).message };
              }
            }));

            entry.related = { windowSec: relatedWindowSec, found: candidates.length, files: related };
          }
        }

        return entry;
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            processName,
            since,
            logsFound: matching.length,
            logsReturned: logs.length,
            logs,
          }, null, 2),
        }],
      };
    },
  );
}
