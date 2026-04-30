import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerListFiles(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_files",
    [
      "List files in the TM1 server's data directory (blob/file storage).",
      "Use to browse available CSV, TXT, or other files before building import processes.",
      "Supports subfolder navigation via the path parameter.",
      "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
    ].join(" "),
    {
      path: z.string().optional().describe(
        "Subfolder path (e.g. 'imports' or 'imports/2024'). Empty = root.",
      ),
    },
    async ({ path }) => {
      try {
        const files = await tm1Client.listFiles(path);
        if (files.length === 0) {
          return {
            content: [{
              type: "text",
              text: path ? `No files in '${path}'.` : "No files in root directory.",
            }],
          };
        }
        const head = path ? `${files.length} entries in '${path}':` : `${files.length} entries:`;
        return { content: [{ type: "text", text: `${head}\n${files.join("\n")}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
