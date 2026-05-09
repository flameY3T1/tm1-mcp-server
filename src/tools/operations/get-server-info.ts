import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";

export function registerGetServerInfo(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_info",
    "Return TM1 server configuration (version, name, data directory, timezone, admin host).",
    { ...FORMAT_SCHEMA },
    async ({ format }) => {
      const info = await tm1Client.server.getInfo();
      return payloadResponse(info, format, (i) =>
        renderKV(i as unknown as Record<string, unknown>, "Server info"),
      );
    },
  );
}
