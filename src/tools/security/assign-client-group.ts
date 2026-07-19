import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
export function registerAssignClientGroup(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_assign_client_group",
    "Assign a TM1 client to a group. Idempotent - assigning twice is a no-op.",
    {
      clientName: z.string().describe("Client (user) name"),
      groupName: z.string().describe("Group name"),
    },
    async ({ clientName, groupName }) => {
      await tm1Client.security.assignClientGroup(clientName, groupName);
      return actionResponse({ success: true, clientName, groupName });
    },
  );
}
