import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import type { DataSource, ProcessParameter, ProcessVariable } from "../../types.js";

const parameterSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

const variableSchema = z.object({
  name: z.string(),
  type: z.enum(["String", "Numeric"]),
  position: z.number(),
  startByte: z.number().optional(),
  endByte: z.number().optional(),
});

const dataSourceSchema = z.object({
  type: z.enum(["None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process"]),
  dataSourceNameForServer: z.string().optional(),
  dataSourceNameForClient: z.string().optional(),
  asciiDelimiterType: z.string().optional(),
  asciiDelimiterChar: z.string().optional(),
  asciiQuoteCharacter: z.string().optional(),
  asciiHeaderRecords: z.number().optional(),
  asciiDecimalSeparator: z.string().optional(),
  asciiThousandSeparator: z.string().optional(),
  usesUnicode: z.boolean().optional(),
  userName: z.string().optional(),
  password: z.string().optional(),
  oDBCConnection: z.string().optional(),
  query: z.string().optional(),
  view: z.string().optional(),
  subset: z.string().optional(),
});

export function registerCheckProcessCode(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_check_process_code",
    [
      "Validate TI process code WITHOUT saving it on the server (POST /api/v1/CompileProcess unbound).",
      "Pre-flight check before tm1_create_process / tm1_update_process_code to avoid create-with-rollback patterns.",
      "Returns 'valid' or a list of syntax errors with procedure (Prolog/Metadata/Data/Epilog) and line number.",
      "All procedure tabs default to empty strings if omitted; pass only the tabs you want to validate.",
    ].join(" "),
    {
      name: z.string().optional().describe("Process name used in the synthetic body (no save). Default '_compile_check'."),
      prolog: z.string().optional().describe("Prolog tab TI code"),
      metadata: z.string().optional().describe("Metadata tab TI code"),
      data: z.string().optional().describe("Data tab TI code"),
      epilog: z.string().optional().describe("Epilog tab TI code"),
      parameters: z.array(parameterSchema).optional().describe("TI parameters (Name, Type, defaultValue, optional Prompt)"),
      variables: z.array(variableSchema).optional().describe("TI variables (column mapping for ASCII/ODBC)"),
      dataSource: dataSourceSchema.optional().describe("DataSource config — defaults to { type: 'None' } when omitted"),
    },
    async ({ name, prolog, metadata, data, epilog, parameters, variables, dataSource }) => {
      try {
        const result = await tm1Client.checkProcessCode({
          ...(name !== undefined ? { name } : {}),
          ...(prolog !== undefined ? { prolog } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(epilog !== undefined ? { epilog } : {}),
          ...(parameters !== undefined ? { parameters: parameters as ProcessParameter[] } : {}),
          ...(variables !== undefined ? { variables: variables as ProcessVariable[] } : {}),
          ...(dataSource !== undefined ? { dataSource: dataSource as DataSource } : {}),
        });
        if (result.success) {
          return { content: [{ type: "text", text: `Process code valid (no syntax errors). Safe to apply with tm1_create_process / tm1_update_process_code.` }] };
        }
        const lines = result.errors.map((e) => {
          const loc = [e.procedure, e.lineNumber !== undefined ? `line ${e.lineNumber}` : undefined]
            .filter(Boolean)
            .join(" ");
          return loc ? `[${loc}] ${e.message}` : e.message;
        });
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Compile errors (${result.errors.length}):\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
