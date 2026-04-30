import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetServerInfo(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_server_info",
    "Return TM1 server configuration (version, name, data directory, timezone, admin host).",
    {},
    async () => {
      try {
        const info = await tm1Client.getServerInfo();
        const lines = [
          `Server: ${info.serverName}`,
          `Version: ${info.productVersion}${info.productEdition ? ` (${info.productEdition})` : ""}`,
        ];
        if (info.adminHost) lines.push(`AdminHost: ${info.adminHost}`);
        if (info.dataDirectory) lines.push(`DataDirectory: ${info.dataDirectory}`);
        if (info.timeZoneId) lines.push(`TimeZone: ${info.timeZoneId}`);
        if (info.integratedSecurityMode) lines.push(`SecurityMode: ${info.integratedSecurityMode}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
