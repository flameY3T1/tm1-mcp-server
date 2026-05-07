import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCreateCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_cube",
    [
      "Create a new TM1 cube with the specified dimensions.",
      "The dimension order matters for performance: put dimensions used most often in WHERE clauses first.",
      "All referenced dimensions must exist before calling this tool.",
    ].join(" "),
    {
      name: z.string().describe("Cube name"),
      dimensions: z.array(z.string()).min(2)
        .describe("Ordered list of dimension names. Order affects query performance."),
    },
    async ({ name, dimensions }) => {
      await tm1Client.createCube(name, dimensions);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            cubeName: name,
            dimensionCount: dimensions.length,
            dimensions,
          }, null, 2),
        }],
      };
    },
  );
}
