import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { PAGINATION_SCHEMA } from "../pagination.js";
import { FORMAT_SCHEMA, payloadResponse } from "../format.js";
import { renderMdxMarkdown, type MdxEnvelope } from "./execute-mdx.js";

interface ViewEnvelope extends MdxEnvelope {
  cubeName: string;
  viewName: string;
}

export function registerGetView(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_view",
    [
      "Execute a named cube view and return structured cell data with axes (page-envelope shape consistent with tm1_execute_mdx).",
      "Cells paginate by default so wide/tall views don't flood context; fetchAll=true for the full cellset.",
      "format='markdown' renders a pivot grid (2 axes, full result) or a flat coordinate table; 'json' (default) returns the structured envelope.",
    ].join(" "),
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      viewName: z.string().describe("Name of the view to execute"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ cubeName, viewName, limit, offset, fetchAll, format }, extra) => {
      const all = fetchAll === true || limit === 0;
      const top = all ? undefined : limit;
      const skip = all ? undefined : offset;
      const result = await tm1Client.views.getView(cubeName, viewName, top, skip, {
        signal: extra?.signal,
      });

      const total = result.totalCellCount;
      const count = result.cells.length;
      const off = all ? 0 : offset;
      const has_more = !all && off + count < total;
      const envelope: ViewEnvelope = {
        cubeName,
        viewName,
        axes: result.axes,
        total,
        count,
        offset: off,
        has_more,
        next_offset: has_more ? off + count : null,
        items: result.cells,
      };
      return payloadResponse(envelope, format, renderMdxMarkdown);
    },
  );
}
