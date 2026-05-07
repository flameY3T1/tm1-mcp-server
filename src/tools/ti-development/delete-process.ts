import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerDeleteProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_process",
    "Delete a TurboIntegrator process from the TM1 server",
    {
      processName: z.string().describe("Name of the TI process to delete"),
    },
    async ({ processName }) => {
      await tm1Client.deleteProcess(processName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName }) }],
      };
    },
  );
}
