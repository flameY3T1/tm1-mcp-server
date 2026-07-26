import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Cube } from "../../types.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { compareByName } from "../../tm1-client/services/odata-page.js";
import {
  PAGINATION_SCHEMA,
  paginate,
  pageFromServer,
  type Page,
} from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

type CubeOut = Pick<Cube, "name"> &
  Partial<Pick<Cube, "dimensions" | "hasRules">>;

export function registerListCubes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_cubes",
    [
      "List cubes in the TM1 server. Control cubes ('}'-prefixed) excluded unless includeControl=true.",
      "Combinable name filters (nameExact/nameContains/nameRegex) and projection toggles (includeDimensions, includeRules) trim payload on wide models.",
      "Paginated (default 50/page).",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include TM1 control cubes whose names start with '}' (default: false).",
        ),
      includeDimensions: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Include the dimensions[] array per cube (default: true). Set false for compact output on wide cubes.",
        ),
      includeRules: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Include hasRules:boolean per cube (default: false). Triggers one extra OData $select=Rules; useful for audits to skip cubes without rules.",
        ),
      nameExact: z
        .string()
        .optional()
        .describe(
          "Return only the cube whose name matches exactly (case-sensitive). Fast-path for known cube names; overrides nameContains/nameRegex when set.",
        ),
      nameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on cube name."),
      nameRegex: z
        .string()
        .optional()
        .describe(
          "JS regex (case-insensitive) on cube name. Invalid patterns return an error.",
        ),
    },
    async ({
      limit,
      offset,
      fetchAll,
      format,
      includeControl,
      includeDimensions,
      includeRules,
      nameExact,
      nameContains,
      nameRegex,
    }) => {
      const project = (list: Cube[]): CubeOut[] =>
        list.map((c) => {
          const out: CubeOut = { name: c.name };
          if (includeDimensions) out.dimensions = c.dimensions;
          if (includeRules) out.hasRules = c.hasRules ?? false;
          return out;
        });

      const fullScan = async (): Promise<CubeOut[]> => {
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
            const re = compileUserRegex(nameRegex, "i", "nameRegex");
            cubes = cubes.filter((c) => re.test(c.name));
          }
        }
        // Match the pushed-down path's $orderby=Name so a given offset means
        // the same row whichever path served it.
        return project(cubes.sort(compareByName));
      };

      // nameRegex has no OData equivalent, so it must run client-side — and a
      // client-side filter makes @odata.count count rows the caller can never
      // reach. nameExact takes precedence over nameContains/nameRegex
      // (documented), so when it is set the others are not active filters.
      const usesNameRegex =
        nameExact === undefined &&
        nameRegex !== undefined &&
        nameRegex.length > 0;
      const canPushDown = !fetchAll && limit > 0 && !usesNameRegex;

      let page: Page<CubeOut>;
      if (canPushDown) {
        const { items, total } = await tm1Client.cubes.list({
          includeRules,
          includeControl,
          ...(nameExact !== undefined
            ? { nameExact }
            : nameContains !== undefined
              ? { nameContains }
              : {}),
          page: { top: limit, skip: offset },
        });
        // No @odata.count means no honest total, so redo it as a full scan
        // rather than invent one.
        page =
          total === undefined
            ? paginate(await fullScan(), limit, offset, fetchAll)
            : pageFromServer(project(items), total, offset);
      } else {
        page = paginate(await fullScan(), limit, offset, fetchAll);
      }

      const columns: Column<CubeOut>[] = [
        { header: "name", get: (c) => c.name },
        ...(includeDimensions
          ? [
              {
                header: "dimensions",
                get: (c: CubeOut) => c.dimensions ?? [],
              } as Column<CubeOut>,
            ]
          : []),
        ...(includeRules
          ? [
              {
                header: "hasRules",
                get: (c: CubeOut) => c.hasRules ?? false,
              } as Column<CubeOut>,
            ]
          : []),
      ];
      return pageResponse(page, format, { title: "Cubes", columns });
    },
  );
}
