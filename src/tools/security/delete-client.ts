import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerDeleteClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_client",
    "Delete a TM1 client (user). Irreversible - the client must not have active sessions.",
    {
      name: z.string().describe("Client (user) name"),
    },
    async ({ name }) => {
      await tm1Client.security.deleteClient(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, clientName: name }),
        }],
      };
    },
  );
}
