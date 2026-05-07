import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListDimensions(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_dimensions",
    [
      "List dimensions in the TM1 server with their hierarchy names.",
      "Control dimensions (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control dimensions whose names start with '}' (default: false)"),
    },
    async ({ limit, offset, fetchAll, includeControl }) => {
      let dimensions = await tm1Client.getDimensions();
      if (!includeControl) dimensions = dimensions.filter((d) => !d.name.startsWith("}"));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(paginate(dimensions, limit, offset, fetchAll), null, 2) }],
      };
    },
  );
}
