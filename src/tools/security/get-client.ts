import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_client",
    "Get details for a single TM1 client (user) including group memberships.",
    {
      name: z.string().describe("Client (user) name"),
    },
    async ({ name }) => {
      try {
        const client = await tm1Client.getClient(name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(client, null, 2) }],
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
