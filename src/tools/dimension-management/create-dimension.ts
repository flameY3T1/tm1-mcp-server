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
      await tm1Client.dimensions.create(name);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, dimensionName: name }, null, 2),
        }],
      };
    },
  );
}
