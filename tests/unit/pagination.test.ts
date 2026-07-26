import { describe, it, expect } from "vitest";
import { z } from "zod";
import { paginate, pageFromServer, PAGINATION_SCHEMA } from "../../src/tools/pagination.js";
import { FORMAT_SCHEMA } from "../../src/tools/format.js";
import {
  compareByName,
  escapeOdataLiteral,
  filterClause,
  nameFilterPredicates,
  pageClauseList,
  pageClauses,
  readCount,
  readNestedCount,
} from "../../src/tm1-client/services/odata-page.js";

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => `item${i}`);

  it("returns first page when offset=0", () => {
    const page = paginate(items, 3, 0);
    expect(page.items).toEqual(["item0", "item1", "item2"]);
    expect(page.total).toBe(10);
    expect(page.has_more).toBe(true);
    expect(page.next_offset).toBe(3);
  });

  it("returns final page without has_more", () => {
    const page = paginate(items, 5, 5);
    expect(page.items).toHaveLength(5);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  it("clamps oversized offset", () => {
    const page = paginate(items, 5, 100);
    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.offset).toBe(10);
  });

  describe("fetchAll", () => {
    it("returns every item ignoring limit/offset", () => {
      const page = paginate(items, 3, 7, true);
      expect(page.items).toEqual(items);
      expect(page.count).toBe(10);
      expect(page.total).toBe(10);
      expect(page.offset).toBe(0);
      expect(page.has_more).toBe(false);
      expect(page.next_offset).toBeNull();
    });

    it("returns empty page on empty input", () => {
      const page = paginate([], 50, 0, true);
      expect(page.items).toEqual([]);
      expect(page.total).toBe(0);
      expect(page.has_more).toBe(false);
    });

    it("default-false keeps existing pagination behavior", () => {
      const page = paginate(items, 4, 0);
      expect(page.items).toHaveLength(4);
      expect(page.has_more).toBe(true);
    });
  });
});

// PAGINATION_SCHEMA + FORMAT_SCHEMA are spread into 19 tool input schemas, so
// their serialized form is paid 19x in every tools/list payload. These pin the
// contract two ways: the parse behaviour agents rely on (unchanged), and the
// description budget (kept short on purpose — see the notes in the source).
describe("shared paging/format input schemas", () => {
  const paging = z.object(PAGINATION_SCHEMA);
  const format = z.object(FORMAT_SCHEMA);

  it("applies the documented defaults when the params are omitted", () => {
    expect(paging.parse({})).toEqual({ limit: 50, offset: 0, fetchAll: false });
    expect(format.parse({})).toEqual({ format: "json" });
  });

  it("accepts limit 0 (= all) and the 500 ceiling", () => {
    expect(paging.parse({ limit: 0 }).limit).toBe(0);
    expect(paging.parse({ limit: 500 }).limit).toBe(500);
  });

  it("rejects out-of-range paging values", () => {
    expect(() => paging.parse({ limit: 501 })).toThrow();
    expect(() => paging.parse({ limit: -1 })).toThrow();
    expect(() => paging.parse({ limit: 1.5 })).toThrow();
    expect(() => paging.parse({ offset: -1 })).toThrow();
  });

  it("accepts both formats and rejects unknown ones", () => {
    expect(format.parse({ format: "markdown" }).format).toBe("markdown");
    expect(() => format.parse({ format: "xml" })).toThrow();
  });

  it("keeps every param described but within the byte budget", () => {
    const described = {
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    } as Record<string, { description?: string | undefined }>;
    for (const [name, schema] of Object.entries(described)) {
      const desc = schema.description ?? "";
      expect(desc.length, `${name} must stay described`).toBeGreaterThan(0);
      expect(desc.length, `${name} description is paid 19x — keep it terse`).toBeLessThanOrEqual(
        60,
      );
      // Defaults/min/max are emitted structurally by JSON Schema; repeating
      // them in prose would be dead weight in all 19 copies.
      expect(desc, `${name} must not restate its default`).not.toMatch(/default/i);
    }
  });
});

describe("pageFromServer", () => {
  const ALL = ["a", "b", "c", "d", "e"];

  it("produces the same envelope paginate() would for the same window", () => {
    for (const offset of [0, 2, 4]) {
      const limit = 2;
      expect(pageFromServer(ALL.slice(offset, offset + limit), ALL.length, offset)).toEqual(
        paginate(ALL, limit, offset, false),
      );
    }
  });

  it("clears has_more on a last page that is exactly `limit` long", () => {
    // 5 rows, offset 3, limit 2 → full page, nothing left. Deriving has_more
    // from `count === limit` would promise a page that comes back empty.
    const page = pageFromServer(["d", "e"], 5, 3);
    expect(page.count).toBe(2);
    expect(page.has_more).toBe(false);
    expect(page.next_offset).toBeNull();
  });

  it("never reports a total below the rows already in hand", () => {
    // The collection shrank between $count and the slice; trust the rows.
    const page = pageFromServer(["d", "e"], 1, 3);
    expect(page.total).toBe(5);
    expect(page.has_more).toBe(false);
  });

  it("copies the item array instead of aliasing the caller's", () => {
    const items = ["a"];
    const page = pageFromServer(items, 1, 0);
    items.push("b");
    expect(page.items).toEqual(["a"]);
  });
});

describe("odata-page clause builders", () => {
  it("always emits $orderby next to $skip", () => {
    // R1: $skip against TM1's internal index order silently duplicates or
    // drops rows once anything is created or deleted mid-walk.
    const clauses = pageClauseList({ top: 50, skip: 100 });
    expect(clauses).toEqual(["$orderby=Name", "$top=50", "$skip=100", "$count=true"]);
    expect(pageClauses({ top: 50, skip: 100 })).toBe(
      "&$orderby=Name&$top=50&$skip=100&$count=true",
    );
  });

  it("emits nothing when unpaged", () => {
    expect(pageClauseList(undefined)).toEqual([]);
    expect(pageClauses(undefined)).toBe("");
    expect(filterClause([])).toBe("");
  });

  it("honours a caller-chosen orderBy property", () => {
    expect(pageClauses({ top: 1, skip: 0, orderBy: "Filename" })).toContain("$orderby=Filename");
  });

  it("excludes control objects unless asked, and lowercases substring needles", () => {
    expect(nameFilterPredicates({})).toEqual(["not startswith(Name,'}')"]);
    expect(nameFilterPredicates({ includeControl: true })).toEqual([]);
    expect(
      nameFilterPredicates({ includeControl: true, nameContains: "Plan", nameNotContains: "TEST" }),
    ).toEqual([
      "contains(tolower(Name),'plan')",
      "not contains(tolower(Name),'test')",
    ]);
    expect(filterClause(nameFilterPredicates({ nameExact: "Sales" }))).toBe(
      "&$filter=not startswith(Name,'}') and Name eq 'Sales'",
    );
  });

  it("ignores empty filter strings rather than emitting a match-nothing predicate", () => {
    expect(
      nameFilterPredicates({ includeControl: true, nameExact: "", nameContains: "" }),
    ).toEqual([]);
  });

  it("doubles quotes so a name cannot break out of an OData literal", () => {
    expect(escapeOdataLiteral("O'Brien")).toBe("O''Brien");
    expect(nameFilterPredicates({ includeControl: true, nameExact: "d'Or" })).toEqual([
      "Name eq 'd''Or'",
    ]);
  });

  it("reads collection and nested counts, and reports absence as undefined", () => {
    expect(readCount({ "@odata.count": 7 })).toBe(7);
    expect(readCount({})).toBeUndefined();
    expect(readCount(undefined)).toBeUndefined();
    expect(readNestedCount({ "Elements@odata.count": 3 }, "Elements")).toBe(3);
    expect(readNestedCount({ Elements: [] }, "Elements")).toBeUndefined();
    expect(readNestedCount(undefined, "Elements")).toBeUndefined();
  });

  it("sorts by ordinal code unit, matching TM1's $orderby=Name", () => {
    // Live-probed: uppercase sorts before lowercase, which localeCompare would
    // get wrong (it collates case-insensitively).
    const names = ["c1", "Alpha", "Zulu"].map((name) => ({ name }));
    expect([...names].sort(compareByName).map((n) => n.name)).toEqual(["Alpha", "Zulu", "c1"]);
    expect(compareByName({ name: "x" }, { name: "x" })).toBe(0);
  });
});
