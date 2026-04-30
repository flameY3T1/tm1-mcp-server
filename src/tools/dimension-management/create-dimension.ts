import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCreateDimension(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_dimension",
    "Create a new TM1 dimension with a default hierarchy of the same name.",
    {
      name: z.string().describe("Dimension name"),
    },
    async ({ name }) => {
      try {
        await tm1Client.createDimension(name);
        return { content: [{ type: "text", text: `Dimension "${name}" created with default hierarchy.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
