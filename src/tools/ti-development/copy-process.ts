import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerCopyProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_copy_process",
    "Copy a TI process (including variables and datasource) to a new name",
    {
      sourceName: z.string().describe("Name of the source TI process"),
      targetName: z.string().describe("Name for the new copy"),
    },
    async ({ sourceName, targetName }) => {
      try {
        await tm1Client.copyProcess(sourceName, targetName);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, sourceName, targetName }) }],
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
