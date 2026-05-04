import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Cube } from "../../types.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListCubes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_cubes",
    [
      "List cubes in the TM1 server with their dimension names.",
      "Control cubes (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Projection: fields=['name'] drops dimensions[] for compact output (recommended for >50 cubes).",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control cubes whose names start with '}' (default: false)"),
      fields: z
        .array(z.enum(["name", "dimensions"]))
        .optional()
        .describe("Projection. Default: all fields. Use ['name'] to skip dimensions[] and shrink payload ~5x for wide cubes."),
    },
    async ({ limit, offset, fetchAll, includeControl, fields }) => {
      try {
        let cubes: Cube[] = await tm1Client.getCubes();
        if (!includeControl) cubes = cubes.filter((c) => !c.name.startsWith("}"));
        const projected: Array<Cube | { name: string }> =
          fields && !fields.includes("dimensions")
            ? cubes.map((c) => ({ name: c.name }))
            : cubes;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(paginate(projected, limit, offset, fetchAll), null, 2) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
