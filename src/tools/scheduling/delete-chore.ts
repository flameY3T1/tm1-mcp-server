import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_chore",
    "Delete a TM1 chore permanently.",
    {
      name: z.string().describe("Chore name (case-sensitive)"),
    },
    async ({ name }) => {
      await tm1Client.chores.delete(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, choreName: name }, null, 2),
        }],
      };
    },
  );
}
