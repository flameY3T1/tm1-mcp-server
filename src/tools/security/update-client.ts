import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

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
      try {
        await tm1Client.updateClient(name, payload);
        return { content: [{ type: "text" as const, text: `Client ${name} updated.` }] };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
