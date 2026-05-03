import { describe, it, expect } from "vitest";
import { parseProFile } from "../../src/lib/pro-parser.js";
import { serializeToPro, type ProcessSerializeInput } from "../../src/lib/pro-serializer.js";
import type { DataSource, ProcessParameter, ProcessVariable } from "../../src/types.js";

function fixture(over: Partial<ProcessSerializeInput> = {}): ProcessSerializeInput {
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
    ...over,
  };
}

describe("pro-serializer round-trip", () => {
  it("name survives", () => {
    const out = serializeToPro(fixture());
    expect(parseProFile(out).name).toBe("MyProc");
  });

  it("code sections survive (prolog/metadata/data/epilog)", () => {
    const input = fixture();
    const parsed = parseProFile(serializeToPro(input));
    expect(parsed.prolog).toBe(input.prolog);
    expect(parsed.metadata).toBe(input.metadata);
    expect(parsed.data).toBe(input.data);
    expect(parsed.epilog).toBe(input.epilog);
  });

  it("parameters survive (names, types, defaults, prompts)", () => {
    const input = fixture();
    const parsed = parseProFile(serializeToPro(input));
    expect(parsed.parameters).toHaveLength(2);
    const byName = (n: string): ProcessParameter | undefined =>
      parsed.parameters.find((p) => p.name === n);

    const num = byName("pNum");
    expect(num).toBeDefined();
    expect(num?.type).toBe("Numeric");
    expect(num?.defaultValue).toBe(42);
    expect(num?.prompt).toBe("a number");

    const str = byName("pStr");
    expect(str).toBeDefined();
    expect(str?.type).toBe("String");
    expect(str?.defaultValue).toBe("default");
    expect(str?.prompt).toBe("a string");
  });

  it("variables survive (names, types, positions)", () => {
    const input = fixture();
    const parsed = parseProFile(serializeToPro(input));
    expect(parsed.variables).toHaveLength(2);
    const v1 = parsed.variables.find((v: ProcessVariable) => v.name === "vCol1");
    const v2 = parsed.variables.find((v: ProcessVariable) => v.name === "vCol2");
    expect(v1).toMatchObject({ type: "String", position: 1 });
    expect(v2).toMatchObject({ type: "Numeric", position: 2 });
  });

  it("None dataSource maps to NULL and back", () => {
    const out = serializeToPro(fixture({ dataSource: { type: "None" } }));
    const ds = parseProFile(out).dataSource;
    expect(ds.type).toBe("None");
  });

  it("TM1CubeView dataSource survives", () => {
    const ds: DataSource = {
      type: "TM1CubeView",
      dataSourceNameForServer: "Sales",
      dataSourceNameForClient: "Sales",
      view: "MyView",
    };
    const parsed = parseProFile(serializeToPro(fixture({ dataSource: ds })));
    expect(parsed.dataSource).toMatchObject({ type: "TM1CubeView", view: "MyView", dataSourceNameForServer: "Sales" });
  });

  it("ASCII dataSource survives delimiter / quote / header records", () => {
    const ds: DataSource = {
      type: "ASCII",
      dataSourceNameForServer: "input.csv",
      dataSourceNameForClient: "input.csv",
      asciiDelimiterChar: ";",
      asciiQuoteCharacter: '"',
      asciiHeaderRecords: 1,
      asciiDecimalSeparator: ",",
      asciiThousandSeparator: ".",
    };
    const parsed = parseProFile(serializeToPro(fixture({ dataSource: ds })));
    expect(parsed.dataSource).toMatchObject({
      type: "ASCII",
      asciiDelimiterChar: ";",
      asciiQuoteCharacter: '"',
      asciiHeaderRecords: 1,
      asciiDecimalSeparator: ",",
      asciiThousandSeparator: ".",
    });
  });

  it("empty parameters/variables produce a parseable file", () => {
    const out = serializeToPro({ name: "Empty", parameters: [], variables: [], dataSource: { type: "None" } });
    const parsed = parseProFile(out);
    expect(parsed.name).toBe("Empty");
    expect(parsed.parameters).toEqual([]);
    expect(parsed.variables).toEqual([]);
    expect(parsed.dataSource.type).toBe("None");
  });

  it("trailing newline at EOF", () => {
    const out = serializeToPro(fixture());
    expect(out.endsWith("\n")).toBe(true);
  });
});
