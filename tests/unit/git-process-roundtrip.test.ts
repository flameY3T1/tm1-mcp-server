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

/** Build a native #region blob the way the TM1 server emits it (CRLF,
 *  empty tabs omitted). Tab keys are Capitalized. */
function makeTi(tabs: Partial<Record<"Prolog" | "Metadata" | "Data" | "Epilog", string>>): string {
  return (["Prolog", "Metadata", "Data", "Epilog"] as const)
    .filter((k) => tabs[k] && tabs[k]!.length > 0)
    .map((k) => `#region ${k}\r\n${tabs[k]}\r\n#endregion`)
    .join("\r\n");
}

describe("git-process #region round-trip", () => {
  it("serializes json in OData-native field order (top-level + param fields)", () => {
    const { json } = serializeProcessToGit({
      name: "P",
      parameters: [{ name: "pA", type: "Numeric", defaultValue: 1, prompt: "ask" }],
      variables: [],
      dataSource: { type: "None" },
      hasSecurityAccess: true,
    });
    expect(json).toBe(
      `{
  "name": "P",
  "hasSecurityAccess": true,
  "dataSource": {
    "type": "None"
  },
  "parameters": [
    {
      "name": "pA",
      "prompt": "ask",
      "value": 1,
      "type": "Numeric"
    }
  ],
  "variables": []
}
`,
    );
  });

  it("parses #region tabs into prolog/metadata/data/epilog; omitted tab is empty", () => {
    const ti = makeTi({ Prolog: "sP='p';", Data: "sD='d';", Epilog: "sE='e';" });
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe("sP='p';");
    expect(parsed.metadata).toBe("");
    expect(parsed.data).toBe("sD='d';");
    expect(parsed.epilog).toBe("sE='e';");
  });

  it("parses #region case-insensitively (lowercase tab name)", () => {
    const ti = "#region prolog\r\nsP='p';\r\n#endregion";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(parseProcessFromGit(json, ti).prolog).toBe("sP='p';");
  });

  it("rejects a .ti with no #region markers (hard-cut)", () => {
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, "just some text\nno markers")).toThrow(/#region/);
  });

  it("rejects the pre-1.x ### TM1-TI-TAB: layout (hard-cut)", () => {
    const legacy = "### TM1-TI-TAB: prolog ###\n### TM1-TI-TAB: metadata ###\n";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, legacy)).toThrow(/#region/);
  });

  it("rejects a blob with a missing #endregion (next tab's #region follows directly) instead of silently swallowing the following tab", () => {
    // Prolog's #endregion is missing/typo'd; Metadata's #region follows directly.
    // The old non-greedy parser silently absorbed Metadata's content into Prolog
    // and reported found:1 with no error — a silent partial-deploy hazard.
    const ti =
      "#region Prolog\r\nsP='p';\r\n#region Metadata\r\nsM='m';\r\n#endregion";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("rejects a blob with a nested #region/#endregion inside a tab's code (e.g. editor folding markers) instead of silently dropping trailing content", () => {
    // A #region/#endregion pair nested inside Prolog's code (e.g. a PAW folding
    // comment). The old non-greedy parser closed on the FIRST #endregion (the
    // inner one) and silently dropped everything after it — up to and including
    // the real #endregion — with no error.
    const ti =
      "#region Prolog\r\ncode before;\r\n#region MyFold\r\nfolded stuff;\r\n#endregion\r\ncode after;\r\n#endregion";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("rejects an unbalanced #region/#endregion count", () => {
    const ti = "#region Prolog\r\nsP='p';\r\n#endregion\r\n#region Metadata\r\nsM='m';\r\n";
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(() => parseProcessFromGit(json, ti)).toThrow(/#region/);
  });

  it("still parses a valid multi-tab blob (with a tab omitted entirely) after structural validation is added", () => {
    const ti = makeTi({ Prolog: "sP='p';", Data: "sD='d';", Epilog: "sE='e';" });
    const json = JSON.stringify({ name: "P", parameters: [], variables: [], dataSource: { type: "None" } });
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.prolog).toBe("sP='p';");
    expect(parsed.metadata).toBe("");
    expect(parsed.data).toBe("sD='d';");
    expect(parsed.epilog).toBe("sE='e';");
  });

  it("parses git param 'value' (native) into internal defaultValue", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P", hasSecurityAccess: false, dataSource: { type: "None" },
      parameters: [{ name: "pA", prompt: "ask", value: 7, type: "Numeric" }], variables: [],
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({ name: "pA", defaultValue: 7, type: "Numeric" });
  });

  it("still parses legacy 'defaultValue' git files (param back-compat)", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const json = JSON.stringify({
      name: "P", parameters: [{ name: "pA", type: "String", defaultValue: "x" }],
      variables: [], dataSource: { type: "None" },
    });
    expect(parseProcessFromGit(json, ti).parameters[0]).toMatchObject({ name: "pA", defaultValue: "x", type: "String" });
  });

  it("parameters/variables/dataSource survive from json", () => {
    const ti = makeTi({ Prolog: "x=1;" });
    const { json } = serializeProcessToGit(fixture());
    const parsed = parseProcessFromGit(json, ti);
    expect(parsed.parameters.find((p) => p.name === "pNum")).toMatchObject({ type: "Numeric", defaultValue: 42, prompt: "a number" });
    expect(parsed.variables.find((v) => v.name === "vCol1")).toMatchObject({ type: "String", position: 1 });
    expect(parsed.dataSource).toMatchObject({ type: "None" });
  });

  it("ODBC password is stripped from JSON and flagged", () => {
    const ds: DataSource = { type: "ODBC", dataSourceNameForServer: "MyDSN", userName: "etl_user", password: "s3cr3t", query: "SELECT 1" };
    const serialized = serializeProcessToGit(fixture({ dataSource: ds }));
    expect(serialized.credentialsOmitted).toBe(true);
    expect(serialized.json).not.toContain("s3cr3t");
    expect(serialized.json).toContain("etl_user");
    const parsed = parseProcessFromGit(serialized.json, makeTi({ Prolog: "x=1;" }));
    expect(parsed.dataSource.password).toBeUndefined();
  });

  it("no password => credentialsOmitted false", () => {
    expect(serializeProcessToGit(fixture()).credentialsOmitted).toBe(false);
  });

  it("json ends with a trailing newline", () => {
    expect(serializeProcessToGit(fixture()).json.endsWith("\n")).toBe(true);
  });

  it("invalid JSON is rejected", () => {
    expect(() => parseProcessFromGit("{not json", makeTi({ Prolog: "x=1;" }))).toThrow(/not valid JSON/);
  });

  it("rejects a parameter with an invalid type instead of blind-casting it", () => {
    const meta = { name: "P", parameters: [{ name: "pMonth", type: "bad", defaultValue: "1" }], variables: [], dataSource: { type: "None" } };
    expect(() => parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" }))).toThrow(/invalid 'parameters'/);
  });

  it("rejects a non-array variables field", () => {
    const meta = { name: "P", parameters: [], variables: { not: "an array" }, dataSource: { type: "None" } };
    expect(() => parseProcessFromGit(JSON.stringify(meta), makeTi({ Prolog: "x=1;" }))).toThrow(/invalid 'variables'/);
  });

  it("round-trips hasSecurityAccess=true", () => {
    const { json } = serializeProcessToGit(fixture({ hasSecurityAccess: true }));
    expect(parseProcessFromGit(json, makeTi({ Prolog: "x=1;" })).hasSecurityAccess).toBe(true);
  });

  it("parses legacy JSON without hasSecurityAccess to undefined", () => {
    const legacy = JSON.stringify({ name: "Old", parameters: [], variables: [], dataSource: { type: "None" } });
    expect(parseProcessFromGit(legacy, makeTi({ Prolog: "x=1;" })).hasSecurityAccess).toBeUndefined();
  });
});
