import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetHierarchy(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_hierarchy",
    [
      "Get hierarchy elements with parent-child relationships for a dimension.",
      "Filters (level/levelMax/elementType, name filters, compact) reduce payload; capped to topN (default 1000) with truncated=true when the cap clips — raise topN for more.",
      "Filtered-out parents/children are pruned from remaining elements to avoid dangling references.",
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
      nameContains: z.string().optional()
        .describe("Server-side OData substring filter (contains). Case-sensitive. Combine with other filters via AND."),
      nameStartsWith: z.string().optional()
        .describe("Server-side OData prefix filter (startswith). Case-sensitive."),
      nameRegex: z.string().optional()
        .describe("Client-side regex filter on element name (JS RegExp). Use for patterns OData cannot express. Invalid regex throws VALIDATION_ERROR."),
      topN: z.number().int().positive().optional().default(1000)
        .describe("Max elements returned after filter (default 1000). Caps large dimensions; result sets truncated=true when the cap clipped the set. Raise to fetch more."),
      compact: z.boolean().optional().default(false)
        .describe("Drop parents[] and children[] arrays from each element. Use for hierarchy overviews."),
    },
    async ({ dimensionName, hierarchyName, level, levelMax, elementType, nameContains, nameStartsWith, nameRegex, topN, compact }) => {
      const hierarchy = await tm1Client.hierarchies.get(dimensionName, hierarchyName, {
        ...(level !== undefined ? { level } : {}),
        ...(levelMax !== undefined ? { levelMax } : {}),
        ...(elementType !== undefined ? { elementType } : {}),
        ...(nameContains !== undefined ? { nameContains } : {}),
        ...(nameStartsWith !== undefined ? { nameStartsWith } : {}),
        ...(nameRegex !== undefined ? { nameRegex } : {}),
        topN,
      });
      // The service caps the element set at topN; a full page means the cap
      // clipped the (post-filter) result, so more elements may exist.
      const truncated = hierarchy.elements.length === topN;
      const elements = compact
        ? hierarchy.elements.map((e) => ({
            name: e.name,
            type: e.type,
            level: e.level,
          }))
        : hierarchy.elements;
      const output = { ...hierarchy, elements, truncated };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
      };
    },
  );
}
