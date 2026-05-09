import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetProcessParameters(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_parameters",
    "Get the parameters of a TurboIntegrator process including names, types and defaults",
    {
      processName: z.string().describe("Name of the TI process"),
      ...FORMAT_SCHEMA,
    },
    async ({ processName, format }) => {
      const params = await tm1Client.processes.getParameters(processName);
      const payload = { processName, parameters: params };
      type Row = (typeof params)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (p) => p.name },
        { header: "type", get: (p) => p.type },
        { header: "defaultValue", get: (p) => p.defaultValue },
        { header: "prompt", get: (p) => p.prompt ?? "" },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Parameters of ${p.processName}\n\n${renderTable(p.parameters, columns)}`,
      );
    },
  );
}
