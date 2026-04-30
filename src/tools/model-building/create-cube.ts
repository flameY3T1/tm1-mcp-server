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
      try {
        await tm1Client.createCube(name, dimensions);
        return {
          content: [{
            type: "text",
            text: [
              `Cube "${name}" created with ${dimensions.length} dimensions:`,
              dimensions.map((d, i) => `  ${i + 1}. ${d}`).join("\n"),
            ].join("\n"),
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
