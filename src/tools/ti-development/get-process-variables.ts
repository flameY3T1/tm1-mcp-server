import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetProcessVariables(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_variables",
    "Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process",
    {
      processName: z.string().describe("Name of the TI process"),
      ...FORMAT_SCHEMA,
    },
    async ({ processName, format }) => {
      const variables = await tm1Client.processes.getVariables(processName);
      const payload = { processName, variables };
      type Row = (typeof variables)[number];
      const columns: Column<Row>[] = [
        { header: "name", get: (v) => v.name },
        { header: "type", get: (v) => v.type },
        { header: "position", get: (v) => v.position },
        { header: "startByte", get: (v) => v.startByte ?? "" },
        { header: "endByte", get: (v) => v.endByte ?? "" },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Variables of ${p.processName}\n\n${renderTable(p.variables, columns)}`,
      );
    },
  );
}
