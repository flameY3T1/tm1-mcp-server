import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

const dataSourceSchema = z.object({
  type: z.enum(["None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process"]).describe("Data source type"),
  dataSourceNameForServer: z.string().optional().describe("Server-side data source name"),
  dataSourceNameForClient: z.string().optional().describe("Client-side data source name"),
  asciiDelimiterType: z.string().optional().describe("ASCII delimiter type (e.g. 'Character' or 'FixedWidth')"),
  asciiDelimiterChar: z.string().optional().describe("ASCII delimiter character"),
  asciiQuoteCharacter: z.string().optional().describe("ASCII quote character"),
  asciiHeaderRecords: z.number().optional().describe("Number of ASCII header records"),
  asciiDecimalSeparator: z.string().optional().describe("ASCII decimal separator (default '.', set to ',' for European CSVs)"),
  asciiThousandSeparator: z.string().optional().describe("ASCII thousand separator (default ',', set to '.' for European CSVs)"),
  usesUnicode: z.boolean().optional().describe("ASCII source uses Unicode (UTF-8/UTF-16). Default false. **TM1 12 only** — silently dropped (with warn-log) on TM1 11.x via TM1_VERSION env gate."),
  userName: z.string().optional().describe("ODBC user name"),
  password: z.string().optional().describe("ODBC password"),
  oDBCConnection: z.string().optional().describe("ODBC connection string"),
  query: z.string().optional().describe("SQL query for ODBC data source"),
  view: z.string().optional().describe("View name for TM1CubeView data source"),
  subset: z.string().optional().describe("Subset name for TM1DimensionSubset data source"),
});

export function registerUpdateProcessDatasource(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_process_datasource",
    "Update the data source configuration of a TurboIntegrator process",
    {
      processName: z.string().describe("Name of the TI process"),
      dataSource: dataSourceSchema.describe("New data source configuration"),
    },
    async ({ processName, dataSource }) => {
      try {
        await tm1Client.updateProcessDataSource(processName, dataSource);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName }) }],
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
