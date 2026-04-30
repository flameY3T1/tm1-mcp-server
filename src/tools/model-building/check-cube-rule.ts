import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerCheckCubeRule(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_check_cube_rule",
    [
      "Validate the syntax of a TM1 cube rule WITHOUT applying it.",
      "Returns 'valid' or a list of syntax errors with line numbers.",
      "Use this as a pre-flight check before tm1_update_cube_rules to avoid committing broken rules.",
    ].join(" "),
    {
      cube: z.string().describe("Cube name (case-sensitive)"),
      rules: z.string().describe("Full rules text to validate (must include SKIPCHECK; / FEEDERS; structure if used)"),
    },
    async ({ cube, rules }) => {
      try {
        const errors = await tm1Client.checkCubeRule(cube, rules);
        if (errors.length === 0) {
          const lineCount = rules.split("\n").length;
          return {
            content: [{
              type: "text",
              text: `Rule syntax valid for cube "${cube}" (${lineCount} lines). Safe to apply with tm1_update_cube_rules.`,
            }],
          };
        }
        const errorList = errors
          .map((e) => (e.lineNumber !== undefined ? `Line ${e.lineNumber}: ${e.message}` : e.message))
          .join("\n");
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Rule syntax errors in cube "${cube}":\n${errorList}`,
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
