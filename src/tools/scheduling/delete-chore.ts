import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";

export function registerDeleteChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_chore",
    "Delete a TM1 chore permanently. Irreversible — pass confirm=<chore name verbatim>.",
    {
      name: z.string().describe("Chore name (case-sensitive)"),
      ...CONFIRM_SCHEMA,
    },
    async ({ name, confirm }) => {
      requireConfirm(confirm, name, "chore");
      await tm1Client.chores.delete(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, choreName: name }),
        }],
      };
    },
  );
}
