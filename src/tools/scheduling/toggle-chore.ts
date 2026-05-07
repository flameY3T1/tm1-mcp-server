import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerToggleChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_toggle_chore",
    "Activate or deactivate a TM1 chore (enable/disable its schedule).",
    {
      name: z.string().describe("Chore name (case-sensitive)"),
      active: z.boolean().describe("true to activate scheduling, false to deactivate"),
    },
    async ({ name, active }) => {
      await tm1Client.toggleChoreActive(name, active);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, choreName: name, active }, null, 2),
        }],
      };
    },
  );
}
