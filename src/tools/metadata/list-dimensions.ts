import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListDimensions(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_dimensions",
    [
      "List dimensions in the TM1 server with their hierarchy names.",
      "Control dimensions (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Set includeElementCount=true to size each dimension's hierarchies in one round-trip — avoids per-dimension tm1_get_hierarchy calls during audits.",
      "Set includeElementStats=true to get per-Type breakdown {total, numeric, consolidated, string, maxLevel} per hierarchy — drives double-hierarchy / orphan detection without cube/MDX dependency. Heavier payload (scans all elements server-side). Overrides includeElementCount when both set.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
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
      includeElementStats: z
        .boolean()
        .optional()
        .default(false)
        .describe("Attach `elementStats: { hierarchyName: { total, numeric, consolidated, string, maxLevel } }` per dimension. Single round-trip, payload scales with total element count. Use for double-hierarchy audits and orphan detection. Overrides includeElementCount when set. Default false."),
    },
    async ({ limit, offset, fetchAll, format, includeControl, includeElementCount, includeElementStats }) => {
      let dimensions = await tm1Client.dimensions.list({ includeElementCount, includeElementStats });
      if (!includeControl) dimensions = dimensions.filter((d) => !d.name.startsWith("}"));
      const page = paginate(dimensions, limit, offset, fetchAll);
      type Row = (typeof dimensions)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (d) => d.name },
        { header: "hierarchies", get: (d) => d.hierarchies },
        ...(includeElementStats
          ? [{ header: "elementStats", get: (d: Row) => d.elementStats ?? {} } as Column<Row>]
          : includeElementCount
            ? [{ header: "elementCounts", get: (d: Row) => d.elementCounts ?? {} } as Column<Row>]
            : []),
      ];
      return pageResponse(page, format, { title: "Dimensions", columns });
    },
  );
}
