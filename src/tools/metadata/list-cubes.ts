import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListCubes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_cubes",
    [
      "List cubes in the TM1 server with their dimension names.",
      "Control cubes (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control cubes whose names start with '}' (default: false)"),
    },
    async ({ limit, offset, includeControl }) => {
      try {
        let cubes = await tm1Client.getCubes();
        if (!includeControl) cubes = cubes.filter((c) => !c.name.startsWith("}"));
        return {
          content: [{ type: "text" as const, text: JSON.stringify(paginate(cubes, limit, offset), null, 2) }],
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
