import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetProcessDatasource(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_datasource",
    "Get the data source configuration of a TurboIntegrator process",
    {
      processName: z.string().describe("Name of the TI process"),
    },
    async ({ processName }) => {
      const ds = await tm1Client.getProcessDataSource(processName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(ds, null, 2) }],
      };
    },
  );
}
