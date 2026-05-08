import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetProcessParameters(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_parameters",
    "Get the parameters of a TurboIntegrator process including names, types and defaults",
    {
      processName: z.string().describe("Name of the TI process"),
    },
    async ({ processName }) => {
      const params = await tm1Client.getProcessParameters(processName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ processName, parameters: params }, null, 2) }],
      };
    },
  );
}
