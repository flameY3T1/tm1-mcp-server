import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetAllProcessesCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_all_processes_code",
    "Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call. Control objects (names starting with '}') excluded by default.",
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control processes whose names start with '}' (default: false)"),
    },
    async ({ includeControl }) => {
      try {
        const all = await tm1Client.getAllProcessesCode(includeControl);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: all.length, processes: all }, null, 2) }],
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
