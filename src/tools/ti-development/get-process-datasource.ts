import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetProcessDatasource(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_datasource",
    "Get the data source configuration of a TurboIntegrator process",
    {
      processName: z.string().describe("Name of the TI process"),
    },
    async ({ processName }) => {
      try {
        const ds = await tm1Client.getProcessDataSource(processName);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(ds, null, 2) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
