import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerUpdateCubeRules(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_update_cube_rules",
    [
      "Create or replace the rules for a TM1 cube.",
      "The rules text must include SKIPCHECK; at the top and FEEDERS; before all feeder definitions.",
      "Replaces existing rules completely — always provide the full rules text.",
    ].join(" "),
    {
      cube: z.string().describe("Cube name (case-sensitive)"),
      rules: z.string().describe("Full rules text (must start with SKIPCHECK; and include FEEDERS; section)"),
      skipCheck: z.boolean().optional().default(true)
        .describe("Enable SKIPCHECK for performance (default: true, recommended)"),
    },
    async ({ cube, rules, skipCheck }) => {
      try {
        await tm1Client.updateCubeRules(cube, rules, skipCheck);
        const lineCount = rules.split("\n").length;
        return {
          content: [{
            type: "text",
            text: `Rules for cube "${cube}" updated (${lineCount} lines, SkipCheck: ${skipCheck}).`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
