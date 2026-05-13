import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { Chore } from "../../types.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";
import { FORMAT_SCHEMA, pageResponse, type Column } from "../format.js";

type ChoreCompact = {
  name: string;
  active: boolean;
  startTime: string;
  frequency: string;
  processCount: number;
};

export function registerListChores(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_chores",
    [
      "List chores in the TM1 server with schedule and assigned processes.",
      "Use compact=true to replace the full processes[] array with processCount (~5–10x payload shrink for chores with many steps).",
      "Filter: processNameContains restricts results to chores whose steps reference a process matching the substring (case-insensitive).",
      "Paginated (default 50/page). Returns {total, count, offset, has_more, next_offset, items}.",
    ].join(" "),
    {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
      compact: z
        .boolean()
        .optional()
        .default(false)
        .describe("Replace processes[] with processCount (default: false)."),
      processNameContains: z
        .string()
        .optional()
        .describe("Return only chores whose steps reference a process name containing this substring (case-insensitive)."),
    },
    async ({ limit, offset, fetchAll, format, compact, processNameContains }) => {
      const chores = await tm1Client.chores.list();
      const filtered = (() => {
        if (processNameContains === undefined || processNameContains.length === 0) return chores;
        const needle = processNameContains.toLowerCase();
        return chores.filter((c) => c.processes.some((p) => p.name.toLowerCase().includes(needle)));
      })();
      const projected: Array<Chore | ChoreCompact> = compact
        ? filtered.map((c): ChoreCompact => ({
            name: c.name,
            active: c.active,
            startTime: c.startTime,
            frequency: c.frequency,
            processCount: c.processes.length,
          }))
        : filtered;
      const page = paginate(projected, limit, offset, fetchAll);
      type Row = (typeof projected)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (c) => c.name },
        { header: "active", get: (c) => c.active },
        { header: "startTime", get: (c) => c.startTime },
        { header: "frequency", get: (c) => c.frequency },
        { header: "processes", get: (c) => ("processes" in c ? c.processes.map((p) => p.name).join(", ") : `${c.processCount} (compact)`) },
      ];
      return pageResponse(page, format, { title: "Chores", columns });
    },
  );
}
