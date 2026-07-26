import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerGetHierarchy(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_hierarchy",
    [
      "Get hierarchy elements with parent-child relationships for a dimension.",
      "Filters (level/levelMax/elementType, name filters, compact) reduce payload; capped to topN (default 1000) with truncated=true when the cap clips.",
      "Elements are ordered by name; walk large dimensions with offset (total/has_more count the filtered element set) rather than raising topN.",
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
        .describe("Page size — max elements returned after filter (default 1000). Combine with offset to walk past it; truncated/has_more say whether more remain."),
      offset: z.number().int().nonnegative().optional().default(0)
        .describe("Elements to skip before topN (default 0). Use next page = offset + topN while has_more is true."),
      compact: z.boolean().optional().default(false)
        .describe("Drop parents[] and children[] arrays from each element. Use for hierarchy overviews."),
    },
    async ({ dimensionName, hierarchyName, level, levelMax, elementType, nameContains, nameStartsWith, nameRegex, topN, offset, compact }) => {
      const { totalElements, ...hierarchy } = await tm1Client.hierarchies.get(
        dimensionName,
        hierarchyName,
        {
          ...(level !== undefined ? { level } : {}),
          ...(levelMax !== undefined ? { levelMax } : {}),
          ...(elementType !== undefined ? { elementType } : {}),
          ...(nameContains !== undefined ? { nameContains } : {}),
          ...(nameStartsWith !== undefined ? { nameStartsWith } : {}),
          ...(nameRegex !== undefined ? { nameRegex } : {}),
          topN,
          skip: offset,
        },
      );
      // `totalElements` counts the whole filtered set, so this is exact — the
      // old `elements.length === topN` test cried truncation whenever the last
      // page happened to be exactly topN long.
      const has_more = offset + hierarchy.elements.length < totalElements;
      const elements = compact
        ? hierarchy.elements.map((e) => ({
            name: e.name,
            type: e.type,
            level: e.level,
          }))
        : hierarchy.elements;
      const output = {
        ...hierarchy,
        elements,
        // Kept as the pre-paging name for `has_more`; both mean "elements the
        // cap left behind".
        truncated: has_more,
        total: totalElements,
        offset,
        has_more,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
      };
    },
  );
}
