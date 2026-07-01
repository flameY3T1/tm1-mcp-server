import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListElementAttributes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_element_attributes",
    "List element attribute definitions of a TM1 hierarchy with their types (Numeric/String/Alias). Useful to verify attribute schema before writing values or referencing them in rules (ATTRN/ATTRS).",
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy within the dimension"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ dimensionName, hierarchyName, limit, offset, fetchAll, format }) => {
      const attributes = await tm1Client.elements.listAttributes(dimensionName, hierarchyName);
      const page = paginate(attributes, limit, offset, fetchAll);
      type Row = (typeof attributes)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (a) => a.name },
        { header: "type", get: (a) => a.type },
      ];
      return pageResponse(page, format, { title: `Element attributes of ${dimensionName}/${hierarchyName}`, columns });
    },
  );
}
