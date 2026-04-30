import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerAssignClientGroup(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_assign_client_group",
    "Assign a TM1 client to a group. Idempotent - assigning twice is a no-op.",
    {
      clientName: z.string().describe("Client (user) name"),
      groupName: z.string().describe("Group name"),
    },
    async ({ clientName, groupName }) => {
      try {
        await tm1Client.assignClientGroup(clientName, groupName);
        return { content: [{ type: "text" as const, text: `Client ${clientName} assigned to group ${groupName}.` }] };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
