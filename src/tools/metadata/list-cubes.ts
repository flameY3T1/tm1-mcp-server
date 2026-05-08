import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Cube } from "../../types.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

type CubeOut = Pick<Cube, "name"> & Partial<Pick<Cube, "dimensions" | "hasRules">>;

export function registerListCubes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_cubes",
    [
      "List cubes in the TM1 server.",
      "Control cubes (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Name filters (combinable, applied after includeControl): nameExact (case-sensitive single match, fast-path), nameContains (case-insensitive substring), nameRegex (JS regex, case-insensitive).",
      "Projection: includeDimensions=false drops dimensions[] (~5x payload shrink for wide cubes). includeRules=true adds hasRules:boolean per cube via a single OData round-trip.",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control cubes whose names start with '}' (default: false)."),
      includeDimensions: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include the dimensions[] array per cube (default: true). Set false for compact output on wide cubes."),
      includeRules: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include hasRules:boolean per cube (default: false). Triggers one extra OData $select=Rules; useful for audits to skip cubes without rules."),
      nameExact: z
        .string()
        .optional()
        .describe("Return only the cube whose name matches exactly (case-sensitive). Fast-path for known cube names; overrides nameContains/nameRegex when set."),
      nameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on cube name."),
      nameRegex: z
        .string()
        .optional()
        .describe("JS regex (case-insensitive) on cube name. Invalid patterns return an error."),
    },
    async ({
      limit,
      offset,
      fetchAll,
      includeControl,
      includeDimensions,
      includeRules,
      nameExact,
      nameContains,
      nameRegex,
    }) => {
      try {
        let cubes: Cube[] = await tm1Client.cubes.list({ includeRules });

        if (!includeControl) {
          cubes = cubes.filter((c) => !c.name.startsWith("}"));
        }

        if (nameExact !== undefined) {
          cubes = cubes.filter((c) => c.name === nameExact);
        } else {
          if (nameContains !== undefined && nameContains.length > 0) {
            const needle = nameContains.toLowerCase();
            cubes = cubes.filter((c) => c.name.toLowerCase().includes(needle));
          }
          if (nameRegex !== undefined && nameRegex.length > 0) {
            let re: RegExp;
            try {
              re = new RegExp(nameRegex, "i");
            } catch (e) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ error: `Invalid nameRegex: ${String(e)}` }),
                  },
                ],
                isError: true,
              };
            }
            cubes = cubes.filter((c) => re.test(c.name));
          }
        }

        const projected: CubeOut[] = cubes.map((c) => {
          const out: CubeOut = { name: c.name };
          if (includeDimensions) out.dimensions = c.dimensions;
          if (includeRules) out.hasRules = c.hasRules ?? false;
          return out;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(paginate(projected, limit, offset, fetchAll), null, 2),
            },
          ],
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
