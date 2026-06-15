import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Process } from "../../types.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

export function registerListProcesses(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_processes",
    [
      "List TurboIntegrator processes in the TM1 server with their parameters.",
      "Control processes (names starting with '}') are excluded by default — set includeControl=true to include them.",
      "Filters: nameContains (case-insensitive substring), nameRegex (JS RegExp), nameNotContains, excludePattern (JS RegExp).",
      "Projection: fields=['name'] drops parameters[] for compact output (recommended for >100 procs).",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
      includeControl: z.boolean().optional().default(false)
        .describe("Include TM1 control processes whose names start with '}' (default: false)"),
      nameContains: z.string().optional()
        .describe("Case-insensitive substring filter on process name."),
      nameRegex: z.string().optional()
        .describe("JS-compatible regex tested against process name (case-insensitive)."),
      nameNotContains: z.string().optional()
        .describe("Case-insensitive substring filter — drop processes whose name contains this substring (e.g. 'TEST', '###NSCH')."),
      excludePattern: z.string().optional()
        .describe("JS-compatible regex (case-insensitive) — drop processes whose name matches. Useful for separator dummies and test patterns, e.g. '^[#-]|^Bedrock\\\\.'."),
      fields: z.array(z.enum(["name", "parameters"])).optional()
        .describe("Projection. Default: all fields. Use ['name'] to skip parameters[] and shrink payload ~10x."),
    },
    async ({ limit, offset, fetchAll, format, includeControl, nameContains, nameRegex, nameNotContains, excludePattern, fields }) => {
      let processes: Process[] = await tm1Client.processes.list();

      if (!includeControl) processes = processes.filter((p) => !p.name.startsWith("}"));

      if (nameContains) {
        const needle = nameContains.toLowerCase();
        processes = processes.filter((p) => p.name.toLowerCase().includes(needle));
      }
      if (nameRegex) {
        const re = compileUserRegex(nameRegex, "i", "nameRegex");
        processes = processes.filter((p) => re.test(p.name));
      }
      if (nameNotContains) {
        const needle = nameNotContains.toLowerCase();
        processes = processes.filter((p) => !p.name.toLowerCase().includes(needle));
      }
      if (excludePattern) {
        const re = compileUserRegex(excludePattern, "i", "excludePattern");
        processes = processes.filter((p) => !re.test(p.name));
      }

      const projected: Array<Process | { name: string }> =
        fields && !fields.includes("parameters")
          ? processes.map((p) => ({ name: p.name }))
          : processes;

      const page = paginate(projected, limit, offset, fetchAll);
      type Row = (typeof projected)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (p) => p.name },
        { header: "parameters", get: (p) => ("parameters" in p ? (p.parameters?.map((x) => x.name).join(", ") ?? "") : "—") },
      ];
      return pageResponse(page, format, { title: "Processes", columns });
    },
  );
}
