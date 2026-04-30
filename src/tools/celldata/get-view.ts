import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetView(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_view",
    "Execute a named cube view and return structured cell data with axes",
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      viewName: z.string().describe("Name of the view to execute"),
    },
    async ({ cubeName, viewName }) => {
      try {
        const result = await tm1Client.getView(cubeName, viewName);
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
