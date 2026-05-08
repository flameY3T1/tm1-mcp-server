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
      await tm1Client.cubes.delete(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, cubeName: name }, null, 2),
        }],
      };
    },
  );
}
