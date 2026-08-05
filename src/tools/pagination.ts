// Pagination helpers for list_* MCP tools. Two shapes of one envelope:
//
//   paginate()       — slices an in-memory array. Used when the handler had to
//                      fetch the whole collection anyway (a filter TM1 cannot
//                      express, fetchAll, limit=0).
//   pageFromServer() — wraps a page TM1 already sliced via $top/$skip, with
//                      `total` taken from `@odata.count`.
//
// Both produce a byte-identical `Page<T>`, so the push-down decision is
// invisible to callers and needs no output-schema change. Which one a handler
// may use is a correctness question, not a performance one: `@odata.count` is
// computed after `$filter`, so it equals the true total only when *every*
// active filter was pushed down. Any filter that stays client-side must force
// the paginate() path.
import { z } from "zod";

// Hard ceiling for the unbounded modes (`fetchAll`, `limit=0`). Not a page
// size — a backstop. 5000 rows of a typical list item already run into six
// figures of characters; past that the response stops being usable by the
// agent that asked for it, and the honest answer is "here is the first slab,
// keep paging" rather than a response nobody can read.
export const UNBOUNDED_MAX_ITEMS = 5000;

// Descriptions are deliberately terse: this block is inlined into 19 tool input
// schemas, so every byte is paid 19x in every `tools/list` payload. Anything
// JSON Schema already emits structurally (`default`, `minimum`, `maximum`) is
// NOT repeated in prose — only semantics the schema cannot express (0 = all,
// fetchAll's payload cost and its cap) stay in the text.
export const PAGINATION_SCHEMA = {
  limit: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .default(50)
    .describe("Page size; 0 = all."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe("Items to skip."),
  fetchAll: z
    .boolean()
    .optional()
    .default(false)
    // Terse on purpose: this string ships 19x in every tools/list (see the
    // note above and the 60-char gate in tests/unit/pagination.test.ts). The
    // cap is not expressible in JSON Schema — it only applies on this branch —
    // so it has to be prose, but short prose.
    .describe(
      `All items, ignoring limit/offset. Capped ${UNBOUNDED_MAX_ITEMS}.`,
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
    // Bounded even here. `fetchAll` / `limit=0` are escape hatches from the
    // page SIZE, not from every limit: a dimension with 200k elements would
    // otherwise serialize 200k rows into one response and exhaust the caller's
    // context long before TM1 breaks a sweat.
    //
    // The cap reuses the normal envelope instead of inventing a new signal —
    // has_more/next_offset already mean "more rows exist, resume here", so a
    // capped fetchAll is simply a first page the caller can walk on from.
    // Nothing disappears silently.
    const slice = items.slice(0, UNBOUNDED_MAX_ITEMS);
    const has_more = slice.length < items.length;
    return {
      total: items.length,
      count: slice.length,
      offset: 0,
      has_more,
      next_offset: has_more ? slice.length : null,
      items: slice,
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

/**
 * Wrap an already-server-sliced page (`$top`/`$skip`) in the same `Page<T>`
 * envelope `paginate()` produces, using the server's `@odata.count` as `total`.
 *
 * `has_more` is derived from `offset + count < total`, never from
 * `count === limit` — the latter is off by one whenever the last page happens
 * to be exactly `limit` long.
 *
 * Only call this when every active filter was expressed in `$filter`.
 * `@odata.count` counts post-filter rows; if a filter ran client-side, `total`
 * would exceed what the caller can actually reach and `has_more` would promise
 * pages that come back empty. Fall back to `paginate()` over a full fetch in
 * that case.
 */
export function pageFromServer<T>(
  items: readonly T[],
  total: number,
  offset: number,
): Page<T> {
  const safeOffset = Math.max(0, offset);
  // A server total below what we already hold means the collection shrank
  // between the count and the slice; trust the rows we actually have.
  const safeTotal = Math.max(total, safeOffset + items.length);
  const has_more = safeOffset + items.length < safeTotal;
  return {
    total: safeTotal,
    count: items.length,
    offset: safeOffset,
    has_more,
    next_offset: has_more ? safeOffset + items.length : null,
    items: [...items],
  };
}
