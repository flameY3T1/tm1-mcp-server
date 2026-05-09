import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderKV } from "../format.js";

export function registerGetProcessDatasource(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_datasource",
    "Get the data source configuration of a TurboIntegrator process",
    {
      processName: z.string().describe("Name of the TI process"),
      ...FORMAT_SCHEMA,
    },
    async ({ processName, format }) => {
      const ds = await tm1Client.processes.getDataSource(processName);
      return payloadResponse(ds, format, (d) =>
        renderKV(d as unknown as Record<string, unknown>, `Datasource of ${processName}`),
      );
    },
  );
}
