import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerCreateClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_client",
    "Create a new TM1 client (user). Optionally set initial password, friendly name, and group memberships.",
    {
      clientName: z.string().describe("Client (user) name"),
      password: z.string().optional().describe("Initial password (omit if external auth)"),
      friendlyName: z.string().optional().describe("Display name"),
      groups: z.array(z.string()).optional().describe("Group names to assign on creation"),
    },
    async ({ clientName, ...rest }) => {
      await tm1Client.security.createClient({ name: clientName, ...rest });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, name: clientName }) }] };
    },
  );
}
