import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListClients(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_clients",
    "List all TM1 clients (users) with their group memberships. Returns name, friendly name, enabled state, and groups.",
    {},
    async () => {
      try {
        const clients = await tm1Client.listClients();
        if (clients.length === 0) {
          return { content: [{ type: "text" as const, text: "No clients defined." }] };
        }
        const lines = clients.map((c) => {
          const groups = c.Groups?.map((g) => g.Name).join(", ") ?? "";
          const enabled = c.Enabled === false ? " [disabled]" : "";
          const friendly = c.FriendlyName ? ` (${c.FriendlyName})` : "";
          return `- ${c.Name}${friendly}${enabled} groups=[${groups}]`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `${clients.length} client(s):\n${lines.join("\n")}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
