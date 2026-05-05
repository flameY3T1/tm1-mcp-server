import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { tsFromFilename, truncateTail } from "./error-log-helpers.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RELATED_WINDOW_SEC = 10;
const HARD_MAX_RELATED_WINDOW_SEC = 300;
const DEFAULT_RELATED_MAX_FILES = 5;
const HARD_MAX_RELATED_FILES = 20;
const DEFAULT_RELATED_MAX_BYTES = 16 * 1024;

export function registerGetErrorLogContent(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_error_log_content",
    [
      "Fetch the raw text of one TI error log file produced by a failed process run.",
      "Use tm1_list_error_logs first to discover available filenames.",
      "Response is truncated by tail (preferred) or maxBytes to protect the MCP context.",
      "Set includeRelated=true to also pull sibling logs whose embedded timestamp falls",
      "within ±relatedWindowSec of the source log — useful for tracing cascade failures",
      "in chained TI processes (one Bedrock chore -> N sub-processes failing seconds apart).",
    ].join(" "),
    {
      filename: z.string().describe(
        "Exact filename returned by tm1_list_error_logs, e.g. 'MyProc_20260504_123045.log'",
      ),
      tail: z.number().int().positive().max(10000).optional()
        .describe("If set, return only the last N lines (overrides maxBytes byte truncation)."),
      maxBytes: z.number().int().positive().max(HARD_MAX_BYTES).optional()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Truncate to last N bytes if no tail is given (default ${DEFAULT_MAX_BYTES}, hard max ${HARD_MAX_BYTES}).`),
      includeRelated: z.boolean().optional().default(false)
        .describe("If true, also fetch sibling error logs whose embedded YYYYMMDDHHMMSS timestamp is within ±relatedWindowSec of the source log."),
      relatedWindowSec: z.number().int().positive().max(HARD_MAX_RELATED_WINDOW_SEC).optional()
        .default(DEFAULT_RELATED_WINDOW_SEC)
        .describe(`Time window in seconds for related-log discovery (default ${DEFAULT_RELATED_WINDOW_SEC}, max ${HARD_MAX_RELATED_WINDOW_SEC}).`),
      relatedMaxFiles: z.number().int().positive().max(HARD_MAX_RELATED_FILES).optional()
        .default(DEFAULT_RELATED_MAX_FILES)
        .describe(`Cap on number of related logs returned (default ${DEFAULT_RELATED_MAX_FILES}, max ${HARD_MAX_RELATED_FILES}).`),
      relatedMaxBytes: z.number().int().positive().max(HARD_MAX_BYTES).optional()
        .default(DEFAULT_RELATED_MAX_BYTES)
        .describe(`Per-related-log byte cap (tail-truncated, default ${DEFAULT_RELATED_MAX_BYTES}).`),
    },
    async ({ filename, tail, maxBytes, includeRelated, relatedWindowSec, relatedMaxFiles, relatedMaxBytes }) => {
      try {
        const content = await tm1Client.getErrorLogContent(filename);
        const totalBytes = Buffer.byteLength(content, "utf8");

        let body: string;
        let truncated = false;
        let truncationReason: string | undefined;

        if (tail !== undefined) {
          // Strip trailing CR/LF so a file ending in '\n' doesn't yield a phantom empty last line.
          const trimmed = content.replace(/[\r\n]+$/, "");
          const allLines = trimmed.split(/\r?\n/);
          if (allLines.length > tail) {
            body = allLines.slice(-tail).join("\n");
            truncated = true;
            truncationReason = `tail=${tail} (of ${allLines.length} lines)`;
          } else {
            body = trimmed;
          }
        } else if (totalBytes > maxBytes) {
          body = Buffer.from(content, "utf8").subarray(-maxBytes).toString("utf8");
          truncated = true;
          truncationReason = `maxBytes=${maxBytes} (tail-truncated)`;
        } else {
          body = content;
        }

        const payload: Record<string, unknown> = {
          filename,
          totalBytes,
          returnedBytes: Buffer.byteLength(body, "utf8"),
          truncated,
          ...(truncationReason ? { truncationReason } : {}),
          content: body,
        };

        if (includeRelated) {
          const sourceTs = tsFromFilename(filename);
          if (sourceTs === null) {
            payload.related = {
              note: "Source filename has no embedded YYYYMMDDHHMMSS timestamp — relation lookup skipped.",
              files: [],
            };
          } else {
            const allFiles = await tm1Client.getErrorLogFiles({ top: 500 });
            const windowMs = relatedWindowSec * 1000;
            const candidates = allFiles
              .filter((f) => f.filename !== filename)
              .map((f) => ({ filename: f.filename, ts: tsFromFilename(f.filename) }))
              .filter((f): f is { filename: string; ts: number } => f.ts !== null)
              .filter((f) => Math.abs(f.ts - sourceTs) <= windowMs)
              .sort((a, b) => Math.abs(a.ts - sourceTs) - Math.abs(b.ts - sourceTs))
              .slice(0, relatedMaxFiles);

            const fetched = await Promise.all(
              candidates.map(async ({ filename: rf, ts }) => {
                try {
                  const raw = await tm1Client.getErrorLogContent(rf);
                  const rawBytes = Buffer.byteLength(raw, "utf8");
                  const { body: rb, truncated: rt } = truncateTail(raw, relatedMaxBytes);
                  return {
                    filename: rf,
                    deltaSec: Math.round((ts - sourceTs) / 1000),
                    totalBytes: rawBytes,
                    returnedBytes: Buffer.byteLength(rb, "utf8"),
                    truncated: rt,
                    content: rb,
                  };
                } catch (e) {
                  return {
                    filename: rf,
                    deltaSec: Math.round((ts - sourceTs) / 1000),
                    error: (e as Error).message,
                  };
                }
              }),
            );

            payload.related = {
              windowSec: relatedWindowSec,
              found: candidates.length,
              maxFiles: relatedMaxFiles,
              files: fetched,
            };
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
