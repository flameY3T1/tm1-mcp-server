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

export const PAGINATION_SCHEMA = {
  limit: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .default(50)
    .describe("Max items to return per page (default 50, max 500). Use 0 to return all items (equivalent to fetchAll=true). Ignored when fetchAll=true."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Number of items to skip from the start (default 0). Ignored when fetchAll=true."),
  fetchAll: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Return every item in one response, ignoring limit/offset. Use when you need the full set for an audit and want to avoid the multi-page agent loop that drops 'has_more: true'. Risk: large payloads — prefer projection/filters first.",
    ),
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
