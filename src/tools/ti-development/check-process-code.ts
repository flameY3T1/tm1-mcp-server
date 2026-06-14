import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import type { ProcessParameter, ProcessVariable } from "../../types.js";

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
      "Pre-flight check before tm1_upsert_process to avoid create-with-rollback patterns.",
      "Returns 'valid' or a list of syntax errors with procedure (Prolog/Metadata/Data/Epilog) and line number.",
      "All procedure tabs default to empty strings if omitted; pass only the tabs you want to validate.",
    ].join(" "),
    {
      name: z.string().optional().describe("Process name used in the synthetic body (no save). Default '_compile_check'."),
      prolog: z.string().optional().describe("Prolog tab TI code"),
      metadata: z.string().optional().describe("Metadata tab TI code"),
      data: z.string().optional().describe("Data tab TI code"),
      epilog: z.string().optional().describe("Epilog tab TI code"),
      parameters: z.array(parameterSchema).optional().describe("TI parameters (Name, Type, defaultValue, optional Prompt). When omitted and baseProcess is set, inherited from baseProcess."),
      variables: z.array(variableSchema).optional().describe("TI variables (column mapping for ASCII/ODBC). When omitted and baseProcess is set, inherited from baseProcess."),
      dataSource: dataSourceSchema.optional().describe("DataSource config — defaults to { type: 'None' } when omitted"),
      baseProcess: z.string().optional().describe("Existing process name to inherit parameters and variables from. Prevents 'undefined parameter' compile errors when validating code that references params defined on the saved process. Explicit parameters/variables override the inherited values."),
    },
    async ({ name, prolog, metadata, data, epilog, parameters, variables, dataSource, baseProcess }) => {
      let resolvedParams = parameters as ProcessParameter[] | undefined;
      let resolvedVars = variables as ProcessVariable[] | undefined;
      if (baseProcess) {
        if (!resolvedParams) resolvedParams = await tm1Client.processes.getParameters(baseProcess);
        if (!resolvedVars) resolvedVars = await tm1Client.processes.getVariables(baseProcess);
      }
      const result = await tm1Client.processes.check({
        ...(name !== undefined ? { name } : {}),
        ...(prolog !== undefined ? { prolog } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(epilog !== undefined ? { epilog } : {}),
        ...(resolvedParams !== undefined ? { parameters: resolvedParams } : {}),
        ...(resolvedVars !== undefined ? { variables: resolvedVars } : {}),
        ...(dataSource !== undefined ? { dataSource: dataSource } : {}),
      });
      const payload = {
        ok: result.success,
        processName: name ?? "_compile_check",
        errorCount: result.errors.length,
        errors: result.errors,
      };
      return {
        isError: !result.success || undefined,
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
