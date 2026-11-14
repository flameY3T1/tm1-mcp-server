import { z } from "zod";
import { ServerFileReadResultSchema } from "../schemas/items.js";
import { WRITE, withVersion } from "../annotations.js";
import { defineTool } from "../define-tool.js";

const DEFAULT_LINES = 1000;
const HARD_MAX_LINES = 20000;

export const registerReadServerFile = defineTool({
  name: "tm1_read_server_file",
  description: [
    "Read a text file from the TM1 server's file system as TI sees it — e.g. an export a TI process wrote with ASCIIOutput, to check its lines.",
    "v11 only. Use this instead of tm1_get_file_content for files TI wrote or that were copied into the data directory: v11 Blobs only lists files uploaded via REST.",
    "Lines come back verbatim (quotes and delimiters untouched); empty lines are skipped, so this is not a byte-for-byte comparison. Runs one unbound TI process that copies the lines into the logging directory; the copy is deleted after the read.",
  ],
  // Not READ_ONLY: it executes TI and can open any file the TM1 service account
  // can, so it must stay out of the default readonly tool set.
  annotations: withVersion(WRITE, "v11"),
  enabled: (tm1Client) => tm1Client.version === 11,
  output: ServerFileReadResultSchema,
  input: {
    path: z
      .string()
      .min(1)
      .describe(
        "Path as the TM1 server opens it: absolute (C:\\TM1\\data\\out\\export.csv) or relative to the data directory.",
      ),
    maxLines: z
      .number()
      .int()
      .positive()
      .max(HARD_MAX_LINES)
      .optional()
      .default(DEFAULT_LINES)
      .describe(
        `Return at most N lines (default ${DEFAULT_LINES}, hard max ${HARD_MAX_LINES}).`,
      ),
  },
  handler: async ({ path, maxLines }, tm1Client) => {
    const r = await tm1Client.files.readViaTi(path, maxLines);
    const payload = {
      path,
      lineCount: r.lines.length,
      truncated: r.truncated,
      encoding: r.encoding,
      lines: r.lines,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  },
});
