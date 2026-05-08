import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA } from "../pagination.js";

export function registerExecuteMdx(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_execute_mdx",
    "Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*).",
    {
      mdx: z.string().describe("The MDX query string to execute"),
      ...PAGINATION_SCHEMA,
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional()
        .describe("Override the default 30s request timeout for this call (ms, 1000–3600000). Use for heavy MDX over wide views."),
    },
    async ({ mdx, limit, offset, fetchAll, timeoutMs }) => {
      const all = fetchAll === true || limit === 0;
      const top = all ? undefined : limit;
      const skip = all ? undefined : offset;
      const result = await tm1Client.cells.executeMdx(mdx, top, skip, timeoutMs ? { timeoutMs } : undefined);

      const total = result.totalCellCount;
      const count = result.cells.length;
      const off = all ? 0 : offset;
      const has_more = !all && off + count < total;
      const envelope = {
        axes: result.axes,
        total,
        count,
        offset: off,
        has_more,
        next_offset: has_more ? off + count : null,
        items: result.cells,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );
}
