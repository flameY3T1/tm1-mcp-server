// Shared OData paging/filter clause builder for server-side $top/$skip
// push-down.
//
// Lives in the service layer on purpose: `lint:no-flat-api` keeps every OData
// query fragment inside a service, so handlers pass semantic options
// ({page, nameContains, includeControl}) and the service turns them into a
// query string. Nothing here interpolates a caller string without escaping it.
//
// Why the clauses always travel together:
//   $orderby — mandatory. `$skip` without a stable sort is undefined in OData;
//              TM1 answers in internal index order, which shifts whenever an
//              object is created or deleted, so a two-page walk would silently
//              duplicate or drop rows.
//   $count   — the server-side total *after* $filter, which is what the
//              Page<T> envelope's `total` means. Callers must therefore only
//              push down when every active filter is expressible in OData.

export interface PageOpts {
  /** `$top` — page size. Positive integer (comes from a Zod-validated `limit`). */
  top: number;
  /** `$skip` — items to skip. Non-negative integer (Zod-validated `offset`). */
  skip: number;
  /** `$orderby` property. Service-internal literal, never caller input. Default `Name`. */
  orderBy?: string;
}

/** Result of a pushed-down list call. */
export interface Paged<T> {
  items: T[];
  /** `@odata.count`; undefined when the server omitted it (caller must fall back). */
  total: number | undefined;
}

/**
 * The paging clauses as separate `$…=…` fragments, in a fixed order.
 * Returns `[]` when no page was requested.
 *
 * Use this for nested `$expand(...)` option lists (joined with `;`);
 * use {@link pageClauses} for top-level query strings (joined with `&`).
 */
export function pageClauseList(page: PageOpts | undefined): string[] {
  if (page === undefined) return [];
  return [
    `$orderby=${page.orderBy ?? "Name"}`,
    `$top=${page.top}`,
    `$skip=${page.skip}`,
    "$count=true",
  ];
}

/**
 * Top-level paging clauses with a leading `&`, ready to append to a query
 * string that already has at least one parameter. Empty string when unpaged.
 */
export function pageClauses(page: PageOpts | undefined): string {
  const list = pageClauseList(page);
  return list.length === 0 ? "" : `&${list.join("&")}`;
}

/** Read the collection-level `@odata.count` a `$count=true` request adds. */
export function readCount(
  response: { "@odata.count"?: number } | null | undefined,
): number | undefined {
  return response?.["@odata.count"];
}

/**
 * Read the `<Nav>@odata.count` that a nested `$expand=Nav($count=true)` adds to
 * the *parent* entity (TM1 hangs the count off the owner, not the array).
 */
export function readNestedCount(
  response: Record<string, unknown> | null | undefined,
  navigationProperty: string,
): number | undefined {
  const raw = response?.[`${navigationProperty}@odata.count`];
  return typeof raw === "number" ? raw : undefined;
}

/** Double `'` per OData literal rules so a caller string cannot break out of a literal. */
export function escapeOdataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Join filter predicates with `and` into a `&$filter=…` fragment. Empty string when none. */
export function filterClause(predicates: readonly string[]): string {
  return predicates.length === 0 ? "" : `&$filter=${predicates.join(" and ")}`;
}

/**
 * Name-based predicates the `/Cubes`, `/Dimensions` and `/Processes` listings
 * share. Only filters TM1 can evaluate itself belong here — a filter that
 * stays client-side must disable push-down entirely, or `@odata.count` (and
 * with it `total`/`has_more`) over-reports.
 *
 * `nameExact` uses `eq`, which TM1 evaluates case-sensitively — same semantics
 * as the handlers' client-side `===`. `nameContains`/`nameNotContains` are
 * case-insensitive via `tolower`, matching the handlers' `toLowerCase()`.
 */
export interface NameFilterOpts {
  /** false ⇒ exclude `}`-prefixed control objects. */
  includeControl?: boolean;
  nameExact?: string;
  nameContains?: string;
  nameNotContains?: string;
}

export function nameFilterPredicates(opts: NameFilterOpts): string[] {
  const predicates: string[] = [];
  if (opts.includeControl !== true) predicates.push("not startswith(Name,'}')");
  if (opts.nameExact !== undefined && opts.nameExact.length > 0) {
    predicates.push(`Name eq '${escapeOdataLiteral(opts.nameExact)}'`);
  }
  if (opts.nameContains !== undefined && opts.nameContains.length > 0) {
    predicates.push(
      `contains(tolower(Name),'${escapeOdataLiteral(opts.nameContains.toLowerCase())}')`,
    );
  }
  if (opts.nameNotContains !== undefined && opts.nameNotContains.length > 0) {
    predicates.push(
      `not contains(tolower(Name),'${escapeOdataLiteral(opts.nameNotContains.toLowerCase())}')`,
    );
  }
  return predicates;
}

/**
 * Ordinal (UTF-16 code-unit) name comparator. TM1's `$orderby=Name` was
 * live-probed against a 340-dimension / 319-process / 121-cube model and
 * matched this ordering exactly, so the client-side fallback path can present
 * the same order as the pushed-down path. Do not swap in `localeCompare` —
 * it collates case- and accent-insensitively and would diverge.
 */
export function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
