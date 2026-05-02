// Reusable Zod schema fragments for MCP tool outputSchema declarations.
// Centralized so every paginated list_* tool emits the same wire shape and
// the SDK can validate `structuredContent` for clients that consume it.
import { z, type ZodTypeAny } from "zod";

// Returns the raw shape (`{ key: ZodType, ... }`) of a Page<T> envelope so it
// can be passed straight to `server.registerTool({ outputSchema })`. The SDK
// accepts either a ZodRawShape or an AnySchema — raw shape gives the cleanest
// inferred type at the registration site.
export function pageShapeFor<T extends ZodTypeAny>(itemSchema: T) {
  return {
    total: z.number().int().describe("Total items available across all pages"),
    count: z.number().int().describe("Number of items in this page"),
    offset: z.number().int().describe("Offset of the first item in this page"),
    has_more: z.boolean().describe("True if more items exist after this page"),
    next_offset: z
      .number()
      .int()
      .nullable()
      .describe("Offset to pass for the next page, or null when has_more=false"),
    items: z.array(itemSchema).describe("Items in this page"),
  };
}
