import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

const variableSchema = z.object({
  name: z.string().describe("Variable name (referenced inside Metadata/Data tabs)"),
  type: z.enum(["String", "Numeric"]).describe("Variable type"),
  position: z.number().int().min(1).describe("1-based column position in the source file"),
  startByte: z.number().int().optional().describe("FixedWidth only: start byte (default 0)"),
  endByte: z.number().int().optional().describe("FixedWidth only: end byte (default 0)"),
});

export function registerUpdateProcessVariables(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_process_variables",
    "Set the variables of a TurboIntegrator process. Required after assigning an ASCII/ODBC datasource because TM1 does not auto-derive column names without a UI save. Each variable maps a source column to a TI variable name (used in Metadata/Data tabs).",
    {
      processName: z.string().describe("Name of the TI process"),
      variables: z.array(variableSchema).min(1).describe("Variables in source-column order"),
    },
    async ({ processName, variables }) => {
      try {
        await tm1Client.updateProcessVariables(processName, variables);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName, variableCount: variables.length }) }],
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
