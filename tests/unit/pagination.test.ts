import { describe, it, expect } from "vitest";
import { paginate } from "../../src/tools/pagination.js";

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
