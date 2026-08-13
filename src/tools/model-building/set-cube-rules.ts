import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { invalidateCallgraphCache } from "../../lib/callgraph/tm1-adapter.js";
import { withToolHint } from "../error-format.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";

export function registerSetCubeRules(
  server: McpServer,
  tm1Client: TM1Client,
): void {
  server.tool(
    "tm1_set_cube_rules",
    [
      "Create or replace the rules for a TM1 cube.",
      "SKIPCHECK; belongs at the top and FEEDERS; before all feeder definitions — SKIPCHECK is what makes feeders take effect, so rules with feeders need it.",
      "Replaces existing rules completely — always provide the full rules text.",
      "Before: tm1_check_cube_rule to validate syntax. After: tm1_get_cube_rules to read back, tm1_invalidate_callgraph_cache is called automatically (rule changes shift DB() / feeder edges).",
    ].join(" "),
    {
      cubeName: z.string().describe("Cube name (case-sensitive)"),
      rules: z
        .string()
        .describe(
          "Full rules text. Put SKIPCHECK; first and a FEEDERS; section after the rule statements — SKIPCHECK is a line in this text, there is no separate switch for it.",
        ),
      ...CONFIRM_SCHEMA,
    },
    async ({ cubeName, rules, confirm }) => {
      // Replaces the cube's ENTIRE rule file; the previous text is not
      // recoverable through this API. Guards against accidental invocation —
      // not a security control.
      requireConfirm(confirm, cubeName, "cube");
      await withToolHint(
        tm1Client.cubes.updateRules(cubeName, rules),
        `Pre-flight syntax with tm1_check_cube_rule(cubeName='${cubeName}', rules=...) before set_cube_rules. Inspect details for the offending line.`,
      );
      const lineCount = rules.split("\n").length;
      // Rule changes shift call edges (DB(), feeders) — drop callgraph TTL early.
      const { cleared: callgraphEntriesCleared } = invalidateCallgraphCache();
      return actionResponse({
        success: true,
        cubeName,
        lineCount,
        callgraphEntriesCleared,
      });
    },
  );
}
