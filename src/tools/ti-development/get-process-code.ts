import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetProcessCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_code",
    "Get the source code of all four tabs (Prolog, Metadata, Data, Epilog) of a TI process",
    {
      processName: z.string().describe("Name of the TI process"),
    },
    async ({ processName }) => {
      const code = await tm1Client.processes.getCode(processName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(code, null, 2) }],
      };
    },
  );
}
