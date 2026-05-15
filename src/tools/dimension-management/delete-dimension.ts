import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";

export function registerDeleteDimension(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_dimension",
    [
      "Delete a TM1 dimension and all its hierarchies. Warning: fails if the dimension is used in a cube.",
      "Safety: pass confirm=<dimension name verbatim>. Mismatched confirm rejects the call.",
      "Before: tm1_find_orphan_dimensions to confirm the dimension is unused, or tm1_analyze_object_usage for a targeted check.",
    ].join(" "),
    {
      name: z.string().describe("Dimension name (case-sensitive)"),
      ...CONFIRM_SCHEMA,
    },
    async ({ name, confirm }) => {
      requireConfirm(confirm, name, "dimension");
      await tm1Client.dimensions.delete(name);
      return actionResponse({ success: true, dimensionName: name });
    },
  );
}
