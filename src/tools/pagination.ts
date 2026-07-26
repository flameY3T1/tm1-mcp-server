// Client-side pagination helper for list_* MCP tools. Slices an in-memory
// array and returns a structured response with metadata so agents know
// how to fetch the next page without flooding the context window.
//
// We slice in-process rather than push $top/$skip to TM1 because most
// list endpoints already round-trip the full set in one cheap query;
// the bottleneck is the JSON payload returned to the LLM, not the
// TM1 fetch. Future work: push pagination into the REST query for
// truly large collections (transaction log, message log).
import { z } from "zod";

// Descriptions are deliberately terse: this block is inlined into 19 tool input
// schemas, so every byte is paid 19x in every `tools/list` payload. Anything
// JSON Schema already emits structurally (`default`, `minimum`, `maximum`) is
// NOT repeated in prose — only semantics the schema cannot express (0 = all,
// fetchAll's payload cost) stay in the text.
export const PAGINATION_SCHEMA = {
  limit: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .default(50)
    .describe("Page size; 0 = all."),
  offset: z.number().int().min(0).optional().default(0).describe("Items to skip."),
  fetchAll: z
    .boolean()
    .optional()
    .default(false)
    .describe("All items, ignoring limit/offset. Large payload."),
};

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
  items: T[];
}

export function paginate<T>(
  items: readonly T[],
  limit: number,
  offset: number,
  fetchAll = false,
): Page<T> {
  if (fetchAll || limit === 0) {
    return {
      total: items.length,
      count: items.length,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [...items],
    };
  }
  const safeOffset = Math.max(0, Math.min(offset, items.length));
  const slice = items.slice(safeOffset, safeOffset + limit);
  const has_more = safeOffset + slice.length < items.length;
  return {
    total: items.length,
    count: slice.length,
    offset: safeOffset,
    has_more,
    next_offset: has_more ? safeOffset + slice.length : null,
    items: slice,
  };
}
