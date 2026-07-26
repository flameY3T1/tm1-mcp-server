import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Process } from "../../types.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { compareByName } from "../../tm1-client/services/odata-page.js";
import {
  PAGINATION_SCHEMA,
  paginate,
  pageFromServer,
  type Page,
} from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListProcesses(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_processes",
    [
      "List TurboIntegrator processes (with parameters) in the TM1 server. Control processes ('}'-prefixed) excluded unless includeControl=true.",
      "Name filters (nameContains/nameRegex/nameNotContains/excludePattern) and fields=['name'] projection trim payload on large models.",
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
          "Include TM1 control processes whose names start with '}' (default: false)",
        ),
      nameContains: z
        .string()
        .optional()
        .describe("Case-insensitive substring filter on process name."),
      nameRegex: z
        .string()
        .optional()
        .describe(
          "JS-compatible regex tested against process name (case-insensitive).",
        ),
      nameNotContains: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring filter — drop processes whose name contains this substring (e.g. 'TEST', '###NSCH').",
        ),
      excludePattern: z
        .string()
        .optional()
        .describe(
          "JS-compatible regex (case-insensitive) — drop processes whose name matches. Useful for separator dummies and test patterns, e.g. '^[#-]|^Bedrock\\\\.'.",
        ),
      fields: z
        .array(z.enum(["name", "parameters"]))
        .optional()
        .describe(
          "Projection. Default: all fields. Use ['name'] to skip parameters[] and shrink payload ~10x.",
        ),
    },
    async ({
      limit,
      offset,
      fetchAll,
      format,
      includeControl,
      nameContains,
      nameRegex,
      nameNotContains,
      excludePattern,
      fields,
    }) => {
      type Row = Process | { name: string };
      const project = (list: Process[]): Row[] =>
        fields && !fields.includes("parameters")
          ? list.map((p) => ({ name: p.name }))
          : list;

      const fullScan = async (): Promise<Row[]> => {
        let processes: Process[] = await tm1Client.processes.list();

        if (!includeControl)
          processes = processes.filter((p) => !p.name.startsWith("}"));

        if (nameContains) {
          const needle = nameContains.toLowerCase();
          processes = processes.filter((p) =>
            p.name.toLowerCase().includes(needle),
          );
        }
        if (nameRegex) {
          const re = compileUserRegex(nameRegex, "i", "nameRegex");
          processes = processes.filter((p) => re.test(p.name));
        }
        if (nameNotContains) {
          const needle = nameNotContains.toLowerCase();
          processes = processes.filter(
            (p) => !p.name.toLowerCase().includes(needle),
          );
        }
        if (excludePattern) {
          const re = compileUserRegex(excludePattern, "i", "excludePattern");
          processes = processes.filter((p) => !re.test(p.name));
        }
        // Match the pushed-down path's $orderby=Name so a given offset means
        // the same row whichever path served it.
        return project(processes.sort(compareByName));
      };

      // Regex filters have no OData equivalent and must run client-side, which
      // would make @odata.count count rows the caller can never reach.
      const canPushDown =
        !fetchAll && limit > 0 && !nameRegex && !excludePattern;

      let page: Page<Row>;
      if (canPushDown) {
        const { items, total } = await tm1Client.processes.list({
          includeControl,
          ...(nameContains ? { nameContains } : {}),
          ...(nameNotContains ? { nameNotContains } : {}),
          page: { top: limit, skip: offset },
        });
        // No @odata.count means no honest total, so redo it as a full scan.
        page =
          total === undefined
            ? paginate(await fullScan(), limit, offset, fetchAll)
            : pageFromServer(project(items), total, offset);
      } else {
        page = paginate(await fullScan(), limit, offset, fetchAll);
      }

      const columns: Column<Row>[] = [
        { header: "name", get: (p) => p.name },
        {
          header: "parameters",
          get: (p) =>
            "parameters" in p
              ? (p.parameters?.map((x) => x.name).join(", ") ?? "")
              : "—",
        },
      ];
      return pageResponse(page, format, { title: "Processes", columns });
    },
  );
}
