import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";

export function registerDeleteCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_cube",
    [
      "Delete a TM1 cube and all its data. This action is irreversible.",
      "Safety: pass confirm=<cube name verbatim>. Mismatched confirm rejects the call.",
      "Before: tm1_analyze_object_usage to find rules or processes referencing the cube; tm1_get_cube_stats to size the data loss.",
    ].join(" "),
    {
      name: z.string().describe("Cube name (case-sensitive)"),
      ...CONFIRM_SCHEMA,
    },
    async ({ name, confirm }) => {
      requireConfirm(confirm, name, "cube");
      await tm1Client.cubes.delete(name);
      return actionResponse({ success: true, cubeName: name });
    },
  );
}
