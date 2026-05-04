import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

const DEFAULT_MAX_BYTES = 64 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export function registerGetErrorLogContent(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_error_log_content",
    [
      "Fetch the raw text of one TI error log file produced by a failed process run.",
      "Use tm1_list_error_logs first to discover available filenames.",
      "Response is truncated by tail (preferred) or maxBytes to protect the MCP context.",
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
    },
    async ({ filename, tail, maxBytes }) => {
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

        const payload = {
          filename,
          totalBytes,
          returnedBytes: Buffer.byteLength(body, "utf8"),
          truncated,
          ...(truncationReason ? { truncationReason } : {}),
          content: body,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
