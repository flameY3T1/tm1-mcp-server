import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerCreateProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_process",
    "Create a new empty TurboIntegrator process on the TM1 server",
    {
      name: z.string().describe("Name for the new TI process"),
    },
    async ({ name }) => {
      await tm1Client.processes.create(name);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName: name }) }],
      };
    },
  );
}
