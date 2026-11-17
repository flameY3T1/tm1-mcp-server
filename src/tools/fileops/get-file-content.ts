import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveLocalPath } from "../local-file.js";
import { FileContentResultSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { CONTAINER_SCHEMA } from "./container.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;

export const registerGetFileContent = defineTool({
  name: "tm1_get_file_content",
  description: [
    "Read the content of a file from the TM1 server's data directory.",
    "Use to inspect CSV, TXT, or other text files before building import processes.",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container. Set container='applications' to read a document out of the Applications tree; a folder or a view reference there carries no content and is refused by name.",
    "encoding='base64' returns the bytes untouched — use it for spreadsheets and other binaries, which a text read would corrupt.",
    "Response is truncated to maxBytes (default 256 KB) to keep MCP messages small.",
    "writeToFile saves the whole file to the MCP host instead and returns only its path, size and SHA-256 — the way to fetch a spreadsheet without passing its bytes through the conversation.",
  ],
  annotations: READ_ONLY,
  output: FileContentResultSchema,
  input: {
    fileName: z
      .string()
      .describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv')",
      ),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_BYTES)
      .optional()
      .default(DEFAULT_MAX_BYTES)
      .describe(
        `Truncate response after N bytes (default ${DEFAULT_MAX_BYTES}, hard max ${HARD_MAX_BYTES}).`,
      ),
    ...CONTAINER_SCHEMA,
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe(
        "How to return the body. 'text' (default) decodes as UTF-8; 'base64' hands back the raw bytes. headLines only applies to text.",
      ),
    headLines: z
      .number()
      .int()
      .positive()
      .max(10000)
      .optional()
      .describe(
        "If set, only return the first N lines (overrides byte truncation).",
      ),
    writeToFile: z
      .string()
      .optional()
      .describe(
        "Absolute host path to write the file to, byte-for-byte and never truncated (maxBytes, headLines and encoding do not apply; an existing file is replaced). The response then carries no content. Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within one of its directories.",
      ),
  },
  handler: async (
    { fileName, maxBytes, headLines, container, encoding, writeToFile },
    tm1Client,
  ) => {
    // Confine the path before the download, so a refused path costs no request.
    const target =
      writeToFile === undefined
        ? undefined
        : resolveLocalPath(writeToFile, "writeToFile");
    const bytes = await tm1Client.files.getContentBytes(fileName, container);
    const totalBytes = bytes.byteLength;

    if (target !== undefined) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              fileName,
              totalBytes,
              writtenTo: target,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            }),
          },
        ],
      };
    }

    let body: string;
    let truncated = false;
    let truncationReason: string | undefined;

    if (encoding === "base64") {
      const slice = bytes.subarray(0, maxBytes);
      body = slice.toString("base64");
      if (slice.byteLength < totalBytes) {
        truncated = true;
        truncationReason = `maxBytes=${maxBytes}`;
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              fileName,
              totalBytes,
              returnedBytes: slice.byteLength,
              truncated,
              ...(truncationReason ? { truncationReason } : {}),
              encoding,
              content: body,
            }),
          },
        ],
      };
    }

    const content = bytes.toString("utf8");
    if (headLines !== undefined) {
      const allLines = content.split("\n");
      body = allLines.slice(0, headLines).join("\n");
      if (allLines.length > headLines) {
        truncated = true;
        truncationReason = `headLines=${headLines} (of ${allLines.length})`;
      }
    } else if (totalBytes > maxBytes) {
      body = Buffer.from(content, "utf8")
        .subarray(0, maxBytes)
        .toString("utf8");
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
      encoding,
      content: body,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
