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
      "Set includeElementCount=true to size each dimension's hierarchies in one round-trip — avoids per-dimension tm1_get_hierarchy calls during audits.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control dimensions whose names start with '}' (default: false)"),
      includeElementCount: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach `elementCounts: { hierarchyName: number }` per dimension via OData $count. Single extra server-side aggregation, no N+1. Default false."),
    },
    async ({ limit, offset, fetchAll, includeControl, includeElementCount }) => {
      let dimensions = await tm1Client.dimensions.list({ includeElementCount });
      if (!includeControl) dimensions = dimensions.filter((d) => !d.name.startsWith("}"));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(paginate(dimensions, limit, offset, fetchAll), null, 2) }],
      };
    },
  );
}
