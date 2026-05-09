import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetServerInfo(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_info",
    "Return TM1 server configuration (version, name, data directory, timezone, admin host).",
    {},
    async () => {
      const info = await tm1Client.server.getInfo();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
      };
    },
  );
}
