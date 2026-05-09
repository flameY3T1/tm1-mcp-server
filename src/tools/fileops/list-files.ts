import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";

export function registerListFiles(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_files",
    [
      "List files in the TM1 server's data directory (blob/file storage).",
      "Use to browse available CSV, TXT, or other files before building import processes.",
      "Supports subfolder navigation via the path parameter.",
      "Auto-falls back from v12 (Files) to v11 (Blobs) container.",
      "Paginated (default 50/page).",
    ].join(" "),
    {
      path: z.string().optional().describe(
        "Subfolder path (e.g. 'imports' or 'imports/2024'). Empty = root.",
      ),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ path, limit, offset, fetchAll, format }) => {
      const files = await tm1Client.files.list(path);
      const page = paginate(files, limit, offset, fetchAll);
      const wrapper = { path: path ?? "", ...page };
      type Row = (typeof files)[number];
      const columns: Column<Row>[] = [{ header: "filename", get: (f) => f }];
      return wrappedPageResponse(wrapper, page, format, { title: `Files in /${path ?? ""}`, columns });
    },
  );
}
