import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerListCubes(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_list_cubes",
    "List all cubes in the TM1 server with their dimension names",
    {},
    async () => {
      try {
        const cubes = await tm1Client.getCubes();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(cubes, null, 2) }],
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
