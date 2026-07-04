import { describe, it, expect } from "vitest";
import {
  serializeProcessToGit,
  parseProcessFromGit,
  type GitProcessInput,
} from "../../src/lib/git-process.js";
import type { DataSource } from "../../src/types.js";

function fixture(over: Partial<GitProcessInput> = {}): GitProcessInput {
  return {
    name: "MyProc",
    prolog: "sTest='hello';\nnX=1;",
    metadata: "",
    data: "ItemReject('skip');",
    epilog: "ProcessExit;",
    parameters: [
      { name: "pNum", type: "Numeric", defaultValue: 42, prompt: "a number" },
      { name: "pStr", type: "String", defaultValue: "default", prompt: "a string" },
    ],
    variables: [
      { name: "vCol1", type: "String", position: 1 },
      { name: "vCol2", type: "Numeric", position: 2 },
    ],
    dataSource: { type: "None" },
    hasSecurityAccess: false,
    ...over,
  };
}

function roundTrip(input: GitProcessInput) {
  const { json, ti } = serializeProcessToGit(input);
  return { json, parsed: parseProcessFromGit(json, ti) };
}

describe("git-process round-trip", () => {
  it("name survives", () => {
    expect(roundTrip(fixture()).parsed.name).toBe("MyProc");
  });

  it("code tabs survive (prolog/metadata/data/epilog)", () => {
    const input = fixture();
    const parsed = roundTrip(input).parsed;
    expect(parsed.prolog).toBe(input.prolog);
    expect(parsed.metadata).toBe(input.metadata);
    expect(parsed.data).toBe(input.data);
    expect(parsed.epilog).toBe(input.epilog);
  });

  it("CRLF code is normalized to LF and survives", () => {
    const input = fixture({ prolog: "a=1;\r\nb=2;\r\n" });
    expect(roundTrip(input).parsed.prolog).toBe("a=1;\nb=2;");
  });

  it("parameters survive (names, types, defaults, prompts)", () => {
    const parsed = roundTrip(fixture()).parsed;
    expect(parsed.parameters).toHaveLength(2);
    expect(parsed.parameters.find((p) => p.name === "pNum")).toMatchObject({
      type: "Numeric",
      defaultValue: 42,
      prompt: "a number",
    });
    expect(parsed.parameters.find((p) => p.name === "pStr")).toMatchObject({
      type: "String",
      defaultValue: "default",
    });
  });

  it("variables survive (names, types, positions)", () => {
    const parsed = roundTrip(fixture()).parsed;
    expect(parsed.variables.find((v) => v.name === "vCol1")).toMatchObject({ type: "String", position: 1 });
    expect(parsed.variables.find((v) => v.name === "vCol2")).toMatchObject({ type: "Numeric", position: 2 });
  });

  it("ASCII dataSource survives", () => {
    const ds: DataSource = {
      type: "ASCII",
      dataSourceNameForServer: "input.csv",
      dataSourceNameForClient: "input.csv",
      asciiDelimiterChar: ";",
      asciiQuoteCharacter: '"',
      asciiHeaderRecords: 1,
      asciiDecimalSeparator: ".",
      asciiThousandSeparator: ".",
    };
    expect(roundTrip(fixture({ dataSource: ds })).parsed.dataSource).toMatchObject({
      type: "ASCII",
      asciiDelimiterChar: ";",
      asciiHeaderRecords: 1,
    });
  });

  it("ODBC password is stripped from JSON and flagged", () => {
    const ds: DataSource = {
      type: "ODBC",
      dataSourceNameForServer: "MyDSN",
      userName: "etl_user",
      password: "s3cr3t",
      query: "SELECT 1",
    };
    const serialized = serializeProcessToGit(fixture({ dataSource: ds }));
    expect(serialized.credentialsOmitted).toBe(true);
    expect(serialized.json).not.toContain("s3cr3t");
    expect(serialized.json).toContain("etl_user");
    expect(parseProcessFromGit(serialized.json, serialized.ti).dataSource.password).toBeUndefined();
  });

  it("no password => credentialsOmitted false", () => {
    expect(serializeProcessToGit(fixture()).credentialsOmitted).toBe(false);
  });

  it("empty parameters/variables round-trip", () => {
    const parsed = roundTrip(fixture({ parameters: [], variables: [] })).parsed;
    expect(parsed.parameters).toEqual([]);
    expect(parsed.variables).toEqual([]);
  });

  it("ti file uses readable tab markers (code outside JSON)", () => {
    const { json, ti } = serializeProcessToGit(fixture());
    expect(ti).toContain("### TM1-TI-TAB: prolog ###");
    expect(ti).toContain("ItemReject('skip');");
    // structure JSON must not carry the code body
    expect(json).not.toContain("ItemReject");
  });

  it("ti without markers is rejected", () => {
    const { json } = serializeProcessToGit(fixture());
    expect(() => parseProcessFromGit(json, "just some text\nno markers")).toThrow(/tab markers/);
  });

  it("invalid JSON is rejected", () => {
    const { ti } = serializeProcessToGit(fixture());
    expect(() => parseProcessFromGit("{not json", ti)).toThrow(/not valid JSON/);
  });

  it("both files end with a trailing newline", () => {
    const { json, ti } = serializeProcessToGit(fixture());
    expect(json.endsWith("\n")).toBe(true);
    expect(ti.endsWith("\n")).toBe(true);
  });

  it("rejects a parameter with an invalid type instead of blind-casting it", () => {
    const { json, ti } = serializeProcessToGit(fixture());
    const meta = JSON.parse(json) as Record<string, unknown>;
    meta.parameters = [{ name: "pMonth", type: "bad", defaultValue: "1" }];
    expect(() => parseProcessFromGit(JSON.stringify(meta), ti)).toThrow(/invalid 'parameters'/);
  });

  it("rejects a non-array variables field", () => {
    const { json, ti } = serializeProcessToGit(fixture());
    const meta = JSON.parse(json) as Record<string, unknown>;
    meta.variables = { not: "an array" };
    expect(() => parseProcessFromGit(JSON.stringify(meta), ti)).toThrow(/invalid 'variables'/);
  });

  it("round-trips hasSecurityAccess=true", () => {
    const { parsed } = roundTrip(fixture({ hasSecurityAccess: true }));
    expect(parsed.hasSecurityAccess).toBe(true);
  });

  it("defaults hasSecurityAccess to false when declared false", () => {
    const { parsed } = roundTrip(fixture());
    expect(parsed.hasSecurityAccess).toBe(false);
  });

  it("parses legacy JSON without the new keys to defaults", () => {
    const legacy = JSON.stringify({
      name: "Old", parameters: [], variables: [], dataSource: { type: "None" },
    });
    const ti = "### TM1-TI-TAB: prolog ###\n### TM1-TI-TAB: metadata ###\n" +
               "### TM1-TI-TAB: data ###\n### TM1-TI-TAB: epilog ###\n";
    const parsed = parseProcessFromGit(legacy, ti);
    expect(parsed.hasSecurityAccess).toBeUndefined();
  });

  it("round-trips a declared hasSecurityAccess=false as false (not undefined)", () => {
    const { parsed } = roundTrip(fixture({ hasSecurityAccess: false }));
    expect(parsed.hasSecurityAccess).toBe(false);
  });
});
