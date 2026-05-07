import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerRemoveClientGroup(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_remove_client_group",
    "Remove a TM1 client from a group.",
    {
      clientName: z.string().describe("Client (user) name"),
      groupName: z.string().describe("Group name"),
    },
    async ({ clientName, groupName }) => {
      await tm1Client.removeClientGroup(clientName, groupName);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, clientName, groupName }, null, 2),
        }],
      };
    },
  );
}
