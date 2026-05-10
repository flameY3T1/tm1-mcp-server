import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

export function registerUploadFile(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_upload_file",
    [
      "Upload (create or update) a file in the TM1 server's blob/file storage.",
      "Use to push CSV, TXT, or other data files that import processes will read.",
      "Provide content as plain text OR base64 (set encoding='base64' for binary).",
      "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
      "v11: subfolders not supported — use a flat file name. v12: nested paths OK if folders exist.",
      `Hard max size: ${HARD_MAX_BYTES} bytes (32 MB).`,
    ].join(" "),
    {
      fileName: z.string().min(1).describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv'). v11 = flat only.",
      ),
      content: z.string().describe(
        "File content. Plain text by default, or base64 string when encoding='base64'.",
      ),
      encoding: z.enum(["text", "base64"]).optional().default("text").describe(
        "Encoding of the `content` field. 'text' (default) for UTF-8 text, 'base64' for binary.",
      ),
    },
    async ({ fileName, content, encoding }) => {
      const bytes = encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf8");

      if (bytes.byteLength > HARD_MAX_BYTES) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  code: "VALIDATION_ERROR",
                  message: `File too large: ${bytes.byteLength} bytes (hard max ${HARD_MAX_BYTES})`,
                  hint: "Split the file or upload a smaller subset. Multipart upload is not yet supported.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const result = await withToolHint(
        tm1Client.files.upload(fileName, bytes),
        "If parent folder is missing, create it on TM1 v12 before retrying. v11 supports root only.",
      );

      const payload = {
        success: true,
        fileName,
        bytesUploaded: bytes.byteLength,
        created: result.created,
        updated: !result.created,
        container: result.root,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}
