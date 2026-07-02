import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerUpdateClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_client",
    "Update a TM1 client. Allowed fields: password, friendlyName, enabled (true=active, false=disabled).",
    {
      name: z.string().describe("Client (user) name"),
      password: z.string().optional().describe("New password"),
      friendlyName: z.string().optional().describe("New display name"),
      enabled: z.boolean().optional().describe("Enable/disable the client"),
    },
    async ({ name, ...payload }) => {
      await tm1Client.security.updateClient(name, payload);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, clientName: name }),
        }],
      };
    },
  );
}
