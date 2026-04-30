import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_cube",
    "Delete a TM1 cube and all its data. This action is irreversible.",
    {
      name: z.string().describe("Cube name (case-sensitive)"),
    },
    async ({ name }) => {
      try {
        await tm1Client.deleteCube(name);
        return { content: [{ type: "text", text: `Cube "${name}" deleted.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
