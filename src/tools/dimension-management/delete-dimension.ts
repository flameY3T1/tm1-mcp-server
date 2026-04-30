import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerDeleteDimension(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_delete_dimension",
    "Delete a TM1 dimension and all its hierarchies. Warning: fails if the dimension is used in a cube.",
    {
      name: z.string().describe("Dimension name (case-sensitive)"),
    },
    async ({ name }) => {
      try {
        await tm1Client.deleteDimension(name);
        return { content: [{ type: "text", text: `Dimension "${name}" deleted.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
