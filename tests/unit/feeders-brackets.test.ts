import { describe, it, expect } from "vitest";
import {
  parseBracketList,
  extractBracketLists,
  type BracketEntry,
} from "../../src/lib/feeders/brackets.js";

describe("parseBracketList — positional unqualified form", () => {
  it("parses single positional element", () => {
    const r = parseBracketList("['Sales']");
    expect(r).not.toBeNull();
    expect(r!.entries).toEqual<BracketEntry[]>([{ elem: "Sales" }]);
    expect(r!.isPositional).toBe(true);
    expect(r!.isMixed).toBe(false);
  });

  it("parses many positional elements (most common feeder form)", () => {
    const r = parseBracketList("['Alpha_Entry', 'Wert', 'DS_000']");
    expect(r!.entries).toEqual<BracketEntry[]>([
      { elem: "Alpha_Entry" },
      { elem: "Wert" },
      { elem: "DS_000" },
    ]);
    expect(r!.isPositional).toBe(true);
  });

  it("tolerates whitespace inside the bracket", () => {
    const r = parseBracketList("[  'A'  ,'B'  ,    'C'  ]");
    expect(r!.entries.map((e) => e.elem)).toEqual(["A", "B", "C"]);
  });
});

describe("parseBracketList — qualified form", () => {
  it("parses single qualified pair", () => {
    const r = parseBracketList("['Year':'2026']");
    expect(r!.entries).toEqual<BracketEntry[]>([{ dim: "Year", elem: "2026" }]);
    expect(r!.isPositional).toBe(false);
    expect(r!.isMixed).toBe(false);
  });

  it("parses multiple qualified pairs", () => {
    const r = parseBracketList(
      "['Region':'North', 'Product':'Widget']",
    );
    expect(r!.entries).toEqual<BracketEntry[]>([
      { dim: "Region", elem: "North" },
      { dim: "Product", elem: "Widget" },
    ]);
  });

  it("parses set form `{...}`", () => {
    const r = parseBracketList("['Year':{'2025','2026','2027'}]");
    expect(r!.entries).toEqual<BracketEntry[]>([
      { dim: "Year", elems: ["2025", "2026", "2027"] },
    ]);
  });
});

describe("parseBracketList — mixed positional + qualified", () => {
  it("flags mixed bracket and preserves both forms", () => {
    const r = parseBracketList("['Year':'2026', 'Sales']");
    expect(r!.entries).toEqual<BracketEntry[]>([
      { dim: "Year", elem: "2026" },
      { elem: "Sales" },
    ]);
    expect(r!.isPositional).toBe(false);
    expect(r!.isMixed).toBe(true);
  });
});

describe("parseBracketList — edge cases", () => {
  it("parses empty brackets as empty entries", () => {
    const r = parseBracketList("[]");
    expect(r).not.toBeNull();
    expect(r!.entries).toEqual([]);
    expect(r!.isPositional).toBe(true);
    expect(r!.isMixed).toBe(false);
  });

  it("handles doubled single-quote escape inside element", () => {
    const r = parseBracketList("['It''s_Sales']");
    expect(r!.entries[0]!.elem).toBe("It's_Sales");
  });

  it("handles doubled single-quote escape inside dim", () => {
    const r = parseBracketList("['My''Dim':'X']");
    expect(r!.entries[0]).toEqual({ dim: "My'Dim", elem: "X" });
  });

  it("returns null on missing brackets", () => {
    expect(parseBracketList("no brackets here")).toBeNull();
  });

  it("returns null on unterminated bracket", () => {
    expect(parseBracketList("['A','B'")).toBeNull();
  });
});

describe("extractBracketLists — finds all bracket lists in a line", () => {
  it("extracts LHS only for a rule with `=`", () => {
    const line = "['Year':'2026', 'Sales'] = N: 1;";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.entries.length).toBe(2);
  });

  it("extracts both LHS and RHS for a feeder with `=>`", () => {
    const line = "['Alpha_Entry', 'Wert'] => ['Alpha'];";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.entries.map((e) => e.elem)).toEqual([
      "Alpha_Entry",
      "Wert",
    ]);
    expect(lists[1]!.entries.map((e) => e.elem)).toEqual(["Alpha"]);
  });

  it("ignores brackets inside string literals", () => {
    const line = "['Real'] = S: 'this [is] not a bracket';";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.entries[0]!.elem).toBe("Real");
  });

  it("handles set form on RHS", () => {
    const line = "['A'] => ['Year':{'2025','2026'}];";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(2);
    expect(lists[1]!.entries[0]).toEqual({ dim: "Year", elems: ["2025", "2026"] });
  });
});

describe("real-world samples from probe", () => {
  it("parses condensed feeder line correctly", () => {
    const line = "['Alpha_Entry', 'Wert', 'DS_000'] => ['Alpha'];";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.isPositional).toBe(true);
    expect(lists[0]!.entries).toHaveLength(3);
    expect(lists[1]!.isPositional).toBe(true);
    expect(lists[1]!.entries).toEqual([{ elem: "Alpha" }]);
  });

  it("parses qualified multi-dim feeder with set form on LHS", () => {
    const line =
      "['Region':'X', 'KPI':{'KN 019', 'KN 020'}, 'Stand':'DS_000'] => ['Driver':'EUR_K'];";
    const lists = extractBracketLists(line);
    expect(lists).toHaveLength(2);
    expect(lists[0]!.entries).toHaveLength(3);
    expect(lists[0]!.entries[1]).toEqual({
      dim: "KPI",
      elems: ["KN 019", "KN 020"],
    });
    expect(lists[1]!.entries[0]).toEqual({
      dim: "Driver",
      elem: "EUR_K",
    });
  });
});
