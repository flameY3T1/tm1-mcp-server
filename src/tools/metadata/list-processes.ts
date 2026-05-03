import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Process } from "../../types.js";
import { TM1Error } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

export function registerListProcesses(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_processes",
    [
      "List TurboIntegrator processes in the TM1 server with their parameters.",
      "Filters: nameContains (case-insensitive substring), nameRegex (JS RegExp).",
      "Projection: fields=['name'] drops parameters[] for compact output (recommended for >100 procs).",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      nameContains: z.string().optional()
        .describe("Case-insensitive substring filter on process name."),
      nameRegex: z.string().optional()
        .describe("JS-compatible regex tested against process name (case-insensitive)."),
      fields: z.array(z.enum(["name", "parameters"])).optional()
        .describe("Projection. Default: all fields. Use ['name'] to skip parameters[] and shrink payload ~10x."),
    },
    async ({ limit, offset, nameContains, nameRegex, fields }) => {
      try {
        let processes: Process[] = await tm1Client.getProcesses();

        if (nameContains) {
          const needle = nameContains.toLowerCase();
          processes = processes.filter((p) => p.name.toLowerCase().includes(needle));
        }
        if (nameRegex) {
          let re: RegExp;
          try {
            re = new RegExp(nameRegex, "i");
          } catch (e) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: `invalid nameRegex: ${(e as Error).message}` }) }],
              isError: true,
            };
          }
          processes = processes.filter((p) => re.test(p.name));
        }

        const projected: Array<Process | { name: string }> =
          fields && !fields.includes("parameters")
            ? processes.map((p) => ({ name: p.name }))
            : processes;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(paginate(projected, limit, offset), null, 2) }],
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
