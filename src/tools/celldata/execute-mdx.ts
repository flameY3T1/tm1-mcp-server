import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerExecuteMdx(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_execute_mdx",
    "Execute an MDX query against the TM1 server and return structured cell data with axes",
    {
      mdx: z.string().describe("The MDX query string to execute"),
      top: z.number().optional().describe("Maximum number of cells to return (pagination)"),
      skip: z.number().optional().describe("Number of cells to skip (pagination)"),
    },
    async ({ mdx, top, skip }) => {
      try {
        const result = await tm1Client.executeMdx(mdx, top, skip);
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
