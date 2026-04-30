import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerCreateProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_create_process",
    "Create a new empty TurboIntegrator process on the TM1 server",
    {
      name: z.string().describe("Name for the new TI process"),
    },
    async ({ name }) => {
      try {
        await tm1Client.createProcess(name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName: name }) }],
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
