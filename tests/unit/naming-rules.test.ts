import { describe, it, expect } from "vitest";
import { checkName, parseMajorVersion } from "../../src/lib/naming/rules.js";

describe("checkName — cube/dim/process (server-reserved kinds)", () => {
  it("accepts a clean name", () => {
    expect(checkName("Sales", "cube")).toEqual([]);
    expect(checkName("Product", "dimension")).toEqual([]);
    expect(checkName("Load_Actuals", "process")).toEqual([]);
  });

  it.each([
    ["a/b", "/"],
    ["a\\b", "\\"],
    ["a:b", ":"],
    ["a*b", "*"],
    ["a?b", "?"],
    ['a"b', '"'],
    ["a<b", "<"],
    ["a>b", ">"],
    ["a|b", "|"],
    ["a'b", "'"],
    ["a;b", ";"],
    ["a,b", ","],
  ])("flags server-reserved char in '%s' (%s)", (name, ch) => {
    const v = checkName(name, "cube");
    expect(v.some((x) => x.rule === "server_reserved_char" && x.char === ch)).toBe(true);
  });

  it("flags control prefix '}'", () => {
    const v = checkName("}MyCube", "cube");
    expect(v.some((x) => x.rule === "leading_control_prefix")).toBe(true);
  });

  it("flags leading/trailing whitespace", () => {
    expect(checkName(" Sales", "cube").some((x) => x.rule === "leading_trailing_whitespace")).toBe(
      true,
    );
    expect(checkName("Sales ", "cube").some((x) => x.rule === "leading_trailing_whitespace")).toBe(
      true,
    );
  });

  it("flags empty / whitespace-only names", () => {
    expect(checkName("", "cube")[0]?.rule).toBe("empty");
    expect(checkName("   ", "cube")[0]?.rule).toBe("empty");
  });

  it("flags length > 256", () => {
    const long = "x".repeat(257);
    expect(checkName(long, "cube").some((x) => x.rule === "length_exceeds")).toBe(true);
  });
});

describe("checkName — element (PA 2.0 v11)", () => {
  it("accepts a clean element name", () => {
    expect(checkName("Jan", "element", 11)).toEqual([]);
  });

  it("flags leading '+' or '-'", () => {
    expect(checkName("+Special", "element", 11)[0]?.rule).toBe("element_leading_arithmetic");
    expect(checkName("-Special", "element", 11)[0]?.rule).toBe("element_leading_arithmetic");
  });

  it("does NOT flag TAB in v11", () => {
    const v = checkName("a\tb", "element", 11);
    expect(v.some((x) => x.rule === "element_contains_tab")).toBe(false);
  });

  it("flags TAB in v12 element names", () => {
    const v = checkName("a\tb", "element", 12);
    expect(v.some((x) => x.rule === "element_contains_tab")).toBe(true);
  });

  it("flags reserved chars in elements", () => {
    const v = checkName("Foo;Bar", "element", 11);
    expect(v.some((x) => x.rule === "server_reserved_char")).toBe(true);
  });

  it("does NOT flag length on long element names (no hard server limit)", () => {
    const long = "e".repeat(500);
    const v = checkName(long, "element", 11);
    expect(v.some((x) => x.rule === "length_exceeds")).toBe(false);
  });

  it("does NOT flag length on long attribute names", () => {
    const long = "a".repeat(500);
    const v = checkName(long, "attribute", 11);
    expect(v.some((x) => x.rule === "length_exceeds")).toBe(false);
  });
});

describe("checkName — processVariable", () => {
  it("accepts a valid TI identifier", () => {
    expect(checkName("vDate", "processVariable")).toEqual([]);
    expect(checkName("v_Account.1", "processVariable")).toEqual([]);
  });

  it("rejects leading digit", () => {
    expect(checkName("1var", "processVariable")[0]?.rule).toBe("process_var_leading_non_letter");
  });

  it("rejects leading underscore", () => {
    expect(checkName("_v", "processVariable")[0]?.rule).toBe("process_var_leading_non_letter");
  });

  it("rejects disallowed special characters", () => {
    expect(checkName("v-name", "processVariable")[0]?.rule).toBe("process_var_invalid_char");
    expect(checkName("v name", "processVariable")[0]?.rule).toBe("process_var_invalid_char");
    expect(checkName("v@name", "processVariable")[0]?.rule).toBe("process_var_invalid_char");
  });

  it("rejects empty variable", () => {
    expect(checkName("", "processVariable")[0]?.rule).toBe("empty");
  });
});

describe("parseMajorVersion", () => {
  it("classifies 11.x as v11", () => {
    expect(parseMajorVersion("11.8.01100")).toBe(11);
  });

  it("classifies 12.x as v12", () => {
    expect(parseMajorVersion("12.0.0")).toBe(12);
  });

  it("classifies >= 12 as v12", () => {
    expect(parseMajorVersion("13.5.0")).toBe(12);
  });

  it("falls back to v11 on empty / unparseable", () => {
    expect(parseMajorVersion("")).toBe(11);
    expect(parseMajorVersion("foo")).toBe(11);
  });
});
