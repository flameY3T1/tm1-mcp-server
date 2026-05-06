import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";

export function registerSetCubeRules(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_set_cube_rules",
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
        // Rule changes shift call edges (DB(), feeders) — drop callgraph TTL early.
        const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();
        return {
          content: [{
            type: "text",
            text: `Rules for cube "${cube}" set (${lineCount} lines, SkipCheck: ${skipCheck}, callgraph cleared: ${callgraphEntriesCleared}).`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
