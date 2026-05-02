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
    .min(1)
    .max(500)
    .optional()
    .default(50)
    .describe("Max items to return per page (default 50, max 500)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Number of items to skip from the start (default 0)"),
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
): Page<T> {
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
