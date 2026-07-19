import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";

export function registerDeleteView(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_view",
    "Delete a public view from a cube. Irreversible — pass confirm=<view name verbatim>.",
    {
      cubeName: z.string().describe("Cube name"),
      viewName: z.string().describe("View name to delete"),
      ...CONFIRM_SCHEMA,
    },
    async ({ cubeName, viewName, confirm }) => {
      requireConfirm(confirm, viewName, "view");
      await tm1Client.views.delete(cubeName, viewName);
      return actionResponse({ success: true, cubeName, viewName });
    },
  );
}
