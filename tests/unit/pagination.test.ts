import { describe, it, expect } from "vitest";
import { z } from "zod";
import { paginate, PAGINATION_SCHEMA } from "../../src/tools/pagination.js";
import { FORMAT_SCHEMA } from "../../src/tools/format.js";

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
