import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetCubeRules(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_cube_rules",
    "Get the current rules text for a TM1 cube. Returns empty string if no rules are defined.",
    {
      cube: z.string().describe("Cube name (case-sensitive)"),
    },
    async ({ cube }) => {
      try {
        const rules = await tm1Client.getCubeRules(cube);
        if (!rules.rulesText) {
          return { content: [{ type: "text", text: `Cube "${cube}" has no rules.` }] };
        }
        return {
          content: [{
            type: "text",
            text: `Rules for cube "${cube}" (SkipCheck: ${rules.skipCheck}):\n\n${rules.rulesText}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
