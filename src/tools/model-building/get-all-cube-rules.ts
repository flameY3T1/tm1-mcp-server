import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetAllCubeRules(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_all_cube_rules",
    "Bulk-load rules text for every cube in one call. Cubes without rules are returned with empty rulesText. Control cubes (names starting with '}') excluded by default.",
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control cubes whose names start with '}' (default: false)"),
      onlyWithRules: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return only cubes that have non-empty rules text (default: false)"),
    },
    async ({ includeControl, onlyWithRules }) => {
      try {
        let all = await tm1Client.getAllCubeRules(includeControl);
        if (onlyWithRules) all = all.filter((c) => c.rulesText.trim().length > 0);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: all.length, cubes: all }, null, 2) }],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
