import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

const parameterSchema = z.object({
  name: z.string().describe("Parameter name"),
  type: z.enum(["String", "Numeric"]).describe("Parameter type"),
  defaultValue: z.union([z.string(), z.number()]).describe("Default value"),
  prompt: z.string().optional().describe("Optional prompt text"),
});

export function registerUpdateProcessParameters(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_process_parameters",
    "Update the parameters of a TurboIntegrator process with names, types and defaults",
    {
      processName: z.string().describe("Name of the TI process"),
      parameters: z.array(parameterSchema).describe("Array of process parameters"),
    },
    async ({ processName, parameters }) => {
      try {
        await tm1Client.updateProcessParameters(processName, parameters);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName, parameterCount: parameters.length }) }],
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
