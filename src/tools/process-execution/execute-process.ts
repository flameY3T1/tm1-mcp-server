import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerExecuteProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_execute_process",
    "Execute a TurboIntegrator process on the TM1 server with optional parameters",
    {
      processName: z.string().describe("Name of the TI process to execute"),
      parameters: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe("Optional key-value map of process parameters"),
    },
    async ({ processName, parameters }) => {
      try {
        const result = await tm1Client.executeProcess(processName, parameters);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
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
