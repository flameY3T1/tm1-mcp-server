import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetHierarchy(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_hierarchy",
    "Get hierarchy elements with parent-child relationships for a given dimension",
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy within the dimension"),
    },
    async ({ dimensionName, hierarchyName }) => {
      try {
        const hierarchy = await tm1Client.getHierarchy(dimensionName, hierarchyName);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(hierarchy, null, 2) }],
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
