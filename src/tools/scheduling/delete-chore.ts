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
      try {
        await tm1Client.deleteChore(name);
        return { content: [{ type: "text", text: `Chore "${name}" deleted.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
