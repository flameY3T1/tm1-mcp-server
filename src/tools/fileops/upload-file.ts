import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { resolveLocalPath } from "../local-file.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { IDEMPOTENT_WRITE } from "../annotations.js";
import { MutationResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { CONTAINER_SCHEMA } from "./container.js";

const HARD_MAX_BYTES = 32 * 1024 * 1024;

export const registerUploadFile = defineTool({
  name: "tm1_upload_file",
  description: [
    "Upload (create or update) a file in the TM1 server's blob/file storage.",
    "Use to push CSV, TXT, or other data files that import processes will read.",
    "Provide content as plain text OR base64 (set encoding='base64' for binary), or sourcePath to send a file from the MCP host byte-for-byte — the way to upload a spreadsheet without passing its bytes through the conversation.",
    "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
    "v11: subfolders not supported — use a flat file name. v12: nested paths OK if folders exist.",
    "container='applications' writes into the Applications tree instead, which nests on both versions. The parent folder must already exist there too, and v11 takes a document only inside a folder, not at the root. A document that already exists there is only replaced with overwrite=true.",
    "The upload is read back and compared by SHA-256: verified=false means the server does not hold the bytes that were sent.",
    `Hard max size: ${HARD_MAX_BYTES} bytes (32 MB).`,
  ],
  annotations: IDEMPOTENT_WRITE,
  output: MutationResultSchema,
  input: {
    fileName: z
      .string()
      .min(1)
      .describe(
        "File name or path (e.g. 'data.csv' or 'imports/sales_2024.csv'). v11 = flat only.",
      ),
    content: z
      .string()
      .optional()
      .describe(
        "File content. Plain text by default, or base64 string when encoding='base64'. Alternative to sourcePath.",
      ),
    sourcePath: z
      .string()
      .optional()
      .describe(
        "Absolute path of a file on the MCP server host to upload unchanged (alternative to content; encoding is ignored). Disabled unless TM1_LOCAL_FILE_ROOT is set; the path must resolve within one of its directories.",
      ),
    encoding: z
      .enum(["text", "base64"])
      .optional()
      .default("text")
      .describe(
        "Encoding of the `content` field. 'text' (default) for UTF-8 text, 'base64' for binary.",
      ),
    ...CONTAINER_SCHEMA,
    overwrite: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "container='applications' only: replace a document that already exists. Default false refuses it. The 'files' container always replaces.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async (
    { fileName, content, sourcePath, encoding, container, overwrite, confirm },
    tm1Client,
  ) => {
    // In the 'files' container this silently replaces an existing server file
    // of the same name. Guards against accidental invocation — not a security
    // control.
    requireConfirm(confirm, fileName, "file");
    if ((content === undefined) === (sourcePath === undefined)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Provide exactly one of content or sourcePath",
      });
    }
    const bytes =
      sourcePath !== undefined
        ? await fs.readFile(resolveLocalPath(sourcePath, "sourcePath"))
        : Buffer.from(content ?? "", encoding === "base64" ? "base64" : "utf8");

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
      tm1Client.files.upload(fileName, bytes, container, overwrite),
      container === "applications"
        ? "The parent folder must already exist. v11 refuses a document directly under the Applications root — name a folder in fileName."
        : "If parent folder is missing, create it on TM1 v12 before retrying. v11 supports root only.",
    );

    // The write is two requests on every route and answers with no body, so
    // only a read tells whether the server holds these bytes. A failed read
    // leaves the upload standing and reports it as unverified.
    const sha256 = sha256Of(bytes);
    const verified = await tm1Client.files
      .getContentBytes(fileName, container)
      .then((back) => sha256Of(back) === sha256)
      .catch(() => false);

    return actionResponse({
      success: true,
      fileName,
      bytesUploaded: bytes.byteLength,
      sha256,
      verified,
      created: result.created,
      updated: !result.created,
      container: result.root,
    });
  },
});

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
