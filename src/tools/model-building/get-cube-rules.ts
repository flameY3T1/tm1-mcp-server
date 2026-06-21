import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetCubeRules(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_cube_rules",
    "Get the current rules text for a TM1 cube. Returns empty string if no rules are defined.",
    {
      cubeName: z.string().describe("Cube name (case-sensitive)"),
    },
    async ({ cubeName }) => {
      const rules = await tm1Client.cubes.getRules(cubeName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rules, null, 2) }],
      };
    },
  );
}
