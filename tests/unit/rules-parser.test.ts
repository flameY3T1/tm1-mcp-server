import { describe, it, expect } from "vitest";
import { parseRules } from "../../src/lib/callgraph/rulesParser.js";

describe("parseRules — hasStet flag", () => {
  it("flags rule line that contains STET", () => {
    const ast = parseRules("['A'] = N: IF(1=1, STET, 0);");
    expect(ast.lines[0]!.hasStet).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(parseRules("['A'] = N: stet;").lines[0]!.hasStet).toBe(true);
    expect(parseRules("['A'] = N: Stet;").lines[0]!.hasStet).toBe(true);
  });

  it("does not flag STET inside a string literal", () => {
    expect(parseRules("['A'] = S: 'STET label';").lines[0]!.hasStet).toBe(false);
  });

  it("does not flag STET inside a `#` comment", () => {
    expect(parseRules("['A'] = N: 1; # STET note").lines[0]!.hasStet).toBe(false);
  });

  it("does not flag SUBSTET or other substrings (word boundary)", () => {
    expect(parseRules("['A'] = N: SUBSTET();").lines[0]!.hasStet).toBe(false);
  });

  it("does not flag blank/comment lines", () => {
    const ast = parseRules("# STET note\n\n");
    expect(ast.lines[0]!.hasStet).toBe(false);
    expect(ast.lines[1]!.hasStet).toBe(false);
  });
});

describe("parseRules — hasIfGuard flag", () => {
  it("flags rule line with IF(...) RHS", () => {
    expect(parseRules("['A'] = N: IF(1=1, 1, 0);").lines[0]!.hasIfGuard).toBe(true);
  });

  it("flags feeder line with IF(...) LHS guard", () => {
    const ast = parseRules("feeders;\nIF(['Year':'2026'] > 0, ['A'] => ['B'], 0);");
    expect(ast.lines[1]!.hasIfGuard).toBe(true);
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(parseRules("['A'] = if (x, 1, 0);").lines[0]!.hasIfGuard).toBe(true);
    expect(parseRules("['A'] = N: If( x, 1, 0);").lines[0]!.hasIfGuard).toBe(true);
  });

  it("does not flag IF inside a string literal", () => {
    expect(parseRules("['A'] = S: 'IF(label)';").lines[0]!.hasIfGuard).toBe(false);
  });

  it("does not flag plain feeder without IF()", () => {
    expect(parseRules("['A'] => ['B'];").lines[0]!.hasIfGuard).toBe(false);
  });

  it("does not match identifier-prefix matches (DIFF, IFNULL — separate function)", () => {
    expect(parseRules("['A'] = N: DIFF(1, 0);").lines[0]!.hasIfGuard).toBe(false);
  });
});
