import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { withToolHint } from "../error-format.js";

export function registerSetCubeRules(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_set_cube_rules",
    [
      "Create or replace the rules for a TM1 cube.",
      "The rules text must include SKIPCHECK; at the top and FEEDERS; before all feeder definitions.",
      "Replaces existing rules completely — always provide the full rules text.",
      "Before: tm1_check_cube_rule to validate syntax. After: tm1_get_cube_rules to read back, tm1_invalidate_callgraph_cache is called automatically (rule changes shift DB() / feeder edges).",
    ].join(" "),
    {
      cubeName: z.string().describe("Cube name (case-sensitive)"),
      rules: z.string().describe("Full rules text (must start with SKIPCHECK; and include FEEDERS; section)"),
      skipCheck: z.boolean().optional().default(true)
        .describe("Enable SKIPCHECK for performance (default: true, recommended)"),
    },
    async ({ cubeName, rules, skipCheck }) => {
      await withToolHint(
        tm1Client.cubes.updateRules(cubeName, rules, skipCheck),
        `Pre-flight syntax with tm1_check_cube_rule(cubeName='${cubeName}', rules=...) before set_cube_rules. Inspect details for the offending line.`,
      );
      const lineCount = rules.split("\n").length;
      // Rule changes shift call edges (DB(), feeders) — drop callgraph TTL early.
      const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            cubeName,
            lineCount,
            skipCheck,
            callgraphEntriesCleared,
          }, null, 2),
        }],
      };
    },
  );
}
