import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerDeleteFile(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_file",
    [
      "Delete a file from the TM1 server's blob/file storage.",
      "Irreversible — file is removed from Files/Blobs container.",
      "Auto-falls back from v12 (Files) to v11 (Blobs).",
      "Returns NOT_FOUND if file is missing in both containers.",
    ].join(" "),
    {
      fileName: z.string().min(1).describe(
        "File name or path (e.g. 'data.csv' or 'imports/old.csv').",
      ),
    },
    async ({ fileName }) => {
      await withToolHint(
        tm1Client.files.delete(fileName),
        "Verify exact name with tm1_list_files or tm1_search_files. Names are case-sensitive.",
      );
      const payload = { success: true, fileName, deleted: true };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      };
    },
  );
}
