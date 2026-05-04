import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";

export function registerGetHierarchy(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_hierarchy",
    [
      "Get hierarchy elements with parent-child relationships for a given dimension.",
      "Filters reduce payload before transit: level (exact), levelMax (≤), elementType (Numeric/String/Consolidated/All), topN (truncate after filter).",
      "Filtered-out parents/children are pruned from remaining elements to avoid dangling references.",
      "Use compact=true to drop the parents[] and children[] arrays and shrink large dimensions ~10x (keeps name/type/level only).",
    ].join(" "),
    {
      dimensionName: z.string().describe("Name of the TM1 dimension"),
      hierarchyName: z.string().describe("Name of the hierarchy within the dimension"),
      level: z.number().int().nonnegative().optional()
        .describe("Exact level filter (0 = leaves, 1+ = consolidations). Combinable with levelMax."),
      levelMax: z.number().int().nonnegative().optional()
        .describe("Keep elements with Level ≤ levelMax. Caps deep hierarchies."),
      elementType: z.enum(["Numeric", "String", "Consolidated", "All"]).optional()
        .describe("Filter by element type. Default: All."),
      topN: z.number().int().positive().optional()
        .describe("Truncate to first N elements after filter. Use to preview large dims."),
      compact: z.boolean().optional().default(false)
        .describe("Drop parents[] and children[] arrays from each element. Use for hierarchy overviews."),
    },
    async ({ dimensionName, hierarchyName, level, levelMax, elementType, topN, compact }) => {
      try {
        const hierarchy = await tm1Client.getHierarchy(dimensionName, hierarchyName, {
          ...(level !== undefined ? { level } : {}),
          ...(levelMax !== undefined ? { levelMax } : {}),
          ...(elementType !== undefined ? { elementType } : {}),
          ...(topN !== undefined ? { topN } : {}),
        });
        const output = compact
          ? {
              ...hierarchy,
              elements: hierarchy.elements.map((e) => ({
                name: e.name,
                type: e.type,
                level: e.level,
              })),
            }
          : hierarchy;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
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
