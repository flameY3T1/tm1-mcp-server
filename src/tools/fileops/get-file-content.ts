import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export function registerGetFileContent(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_file_content",
    [
      "Read the content of a file from the TM1 server's data directory.",
      "Use to inspect CSV, TXT, or other text files before building import processes.",
      "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
      "Response is truncated to maxBytes (default 256 KB) to keep MCP messages small.",
    ].join(" "),
    {
      fileName: z.string().describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv')",
      ),
      maxBytes: z.number().int().positive().max(HARD_MAX_BYTES).optional()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Truncate response after N bytes (default ${DEFAULT_MAX_BYTES}, hard max ${HARD_MAX_BYTES}).`),
      headLines: z.number().int().positive().max(10000).optional()
        .describe("If set, only return the first N lines (overrides byte truncation)."),
    },
    async ({ fileName, maxBytes, headLines }) => {
      const content = await tm1Client.files.getContent(fileName);
      const totalBytes = Buffer.byteLength(content, "utf8");

      let body: string;
      let truncated = false;
      let truncationReason: string | undefined;

      if (headLines !== undefined) {
        const allLines = content.split("\n");
        body = allLines.slice(0, headLines).join("\n");
        if (allLines.length > headLines) {
          truncated = true;
          truncationReason = `headLines=${headLines} (of ${allLines.length})`;
        }
      } else if (totalBytes > maxBytes) {
        body = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
        truncated = true;
        truncationReason = `maxBytes=${maxBytes}`;
      } else {
        body = content;
      }

      const payload = {
        fileName,
        totalBytes,
        returnedBytes: Buffer.byteLength(body, "utf8"),
        truncated,
        ...(truncationReason ? { truncationReason } : {}),
        content: body,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
