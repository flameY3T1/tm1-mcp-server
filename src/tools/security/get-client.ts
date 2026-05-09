import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";

export function registerGetClient(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_client",
    "Get details for a single TM1 client (user) including group memberships.",
    {
      name: z.string().describe("Client (user) name"),
      ...FORMAT_SCHEMA,
    },
    async ({ name, format }) => {
      const client = await tm1Client.security.getClient(name);
      return payloadResponse(client, format, (c) =>
        renderKV(c as unknown as Record<string, unknown>, `Client ${name}`),
      );
    },
  );
}
