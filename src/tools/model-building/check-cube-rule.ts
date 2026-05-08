import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCheckCubeRule(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_check_cube_rule",
    [
      "Validate the syntax of a TM1 cube rule WITHOUT applying it.",
      "Returns 'valid' or a list of syntax errors with line numbers.",
      "Use this as a pre-flight check before tm1_set_cube_rules to avoid committing broken rules.",
    ].join(" "),
    {
      cube: z.string().describe("Cube name (case-sensitive)"),
      rules: z.string().describe("Full rules text to validate (must include SKIPCHECK; / FEEDERS; structure if used)"),
    },
    async ({ cube, rules }) => {
      try {
        const errors = await tm1Client.cubes.checkRule(cube, rules);
        const ok = errors.length === 0;
        const payload = {
          ok,
          cube,
          lineCount: rules.split("\n").length,
          errorCount: errors.length,
          errors: errors.map((e) => ({
            lineNumber: e.lineNumber,
            message: e.message,
          })),
        };
        return {
          isError: !ok || undefined,
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
