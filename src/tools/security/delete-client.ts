import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
export function registerDeleteClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_client",
    "Delete a TM1 client (user). Irreversible - the client must not have active sessions. Pass confirm=<client name verbatim>.",
    {
      name: z.string().describe("Client (user) name"),
      ...CONFIRM_SCHEMA,
    },
    async ({ name, confirm }) => {
      requireConfirm(confirm, name, "client");
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
