import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerDeleteClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_client",
    "Delete a TM1 client (user). Irreversible - the client must not have active sessions.",
    {
      name: z.string().describe("Client (user) name"),
    },
    async ({ name }) => {
      try {
        await tm1Client.deleteClient(name);
        return { content: [{ type: "text" as const, text: `Client ${name} deleted.` }] };
      } catch (error) {
        const msg = error instanceof TM1Error
          ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
          : { error: String(error) };
        return { content: [{ type: "text" as const, text: JSON.stringify(msg) }], isError: true };
      }
    },
  );
}
