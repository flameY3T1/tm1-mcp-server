import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerClearCube(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_clear_cube",
    "Clear a subset of cells from a cube. For each dimension, pass either specific element names or an empty array to select all elements (wildcard). The dimensions array must match the cube's dimension order. Consolidated elements expand to their leaves. Prefer TI for reproducible loads — this is for ad-hoc resets.",
    {
      cubeName: z.string().describe("Cube to clear"),
      dimensions: z.array(z.string()).describe("Cube's dimensions in order"),
      tuples: z.array(z.array(z.string())).describe(
        "Per-dimension element lists (same length as dimensions). Empty array = all elements on that dimension.",
      ),
    },
    async ({ cubeName, dimensions, tuples }) => {
      try {
        if (dimensions.length !== tuples.length) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `dimensions (${dimensions.length}) and tuples (${tuples.length}) must have the same length.`,
            }],
          };
        }
        await tm1Client.clearCube(cubeName, dimensions, tuples);
        const summary = dimensions
          .map((d, i) => `${d}=${tuples[i].length === 0 ? "*" : tuples[i].join("|")}`)
          .join(", ");
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, cubeName, summary }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
