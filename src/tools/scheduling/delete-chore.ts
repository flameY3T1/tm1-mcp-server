import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { actionResponse } from "../format.js";

export function registerDeleteChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_chore",
    "Delete a TM1 chore permanently. Irreversible — pass confirm=<chore name verbatim>.",
    {
      choreName: z.string().describe("Chore name (case-sensitive)"),
      ...CONFIRM_SCHEMA,
    },
    async ({ choreName, confirm }) => {
      requireConfirm(confirm, choreName, "chore");
      await tm1Client.chores.delete(choreName);
      return actionResponse({ success: true, choreName });
    },
  );
}
