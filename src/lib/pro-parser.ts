import type { DataSource, ProcessParameter, ProcessVariable } from "../types.js";

export interface ParsedPro {
  name: string | null;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
}

const SECTION_RE = /^(572|573|574|575),(\d*)$/;

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

function lineValue(line: string): string {
  const idx = line.indexOf(",");
  return idx === -1 ? "" : line.slice(idx + 1);
}

function parseProcessName(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/^602,"(.+)"$/);
    if (m) return m[1] ?? null;
    if (/^572,/.test(line)) break;
  }
  return null;
}

function parseSections(lines: string[]): {
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
} {
  const map: Record<string, string[]> = { "572": [], "573": [], "574": [], "575": [] };
  const headers: Array<{ code: string; idx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(SECTION_RE);
    if (m) headers.push({ code: m[1]!, idx: i });
  }
  for (let h = 0; h < headers.length; h++) {
    const hdr = headers[h]!;
    const { code, idx } = hdr;
    const next = h + 1 < headers.length ? headers[h + 1]!.idx : lines.length;
    for (let j = idx + 1; j < next; j++) {
      const ln = lines[j]!;
      // Stop at any non-section numeric header line (e.g. 576, 930)
      if (/^\d{3},/.test(ln) && !/^57[2345],/.test(ln)) break;
      map[code]!.push(ln);
    }
  }
  return {
    prolog: map["572"]!.join("\n").trimEnd(),
    metadata: map["573"]!.join("\n").trimEnd(),
    data: map["574"]!.join("\n").trimEnd(),
    epilog: map["575"]!.join("\n").trimEnd(),
  };
}

function parseParameters(lines: string[]): ProcessParameter[] {
  const prologIdx = lines.findIndex((l) => /^572,/.test(l));
  const pre = prologIdx === -1 ? lines : lines.slice(0, prologIdx);

  let names: string[] = [];
  let types: number[] = [];
  const defaults: Record<string, string> = {};
  const prompts: Record<string, string> = {};

  let i = 0;
  while (i < pre.length) {
    const m = pre[i]!.match(/^(560|561|590|637),(\d+)$/);
    if (m) {
      const code = m[1]!;
      const count = parseInt(m[2]!, 10);
      const data = pre.slice(i + 1, i + 1 + count);
      if (code === "560") names = data.map((l) => l.trim());
      else if (code === "561") types = data.map((l) => parseInt(l.trim(), 10) || 1);
      else if (code === "590" || code === "637") {
        for (const dl of data) {
          const ci = dl.indexOf(",");
          if (ci === -1) continue;
          const name = dl.slice(0, ci);
          const val = stripQuotes(dl.slice(ci + 1));
          if (code === "590") defaults[name] = val;
          else prompts[name] = val;
        }
      }
      i += 1 + count;
      continue;
    }
    i++;
  }

  return names.map((name, idx) => {
    const proType = types[idx] ?? 1;
    const restType: "String" | "Numeric" = proType === 2 ? "String" : "Numeric";
    const rawValue = defaults[name] ?? "";
    const defaultValue: string | number =
      restType === "Numeric" ? Number(rawValue || "0") || 0 : rawValue;
    return {
      name,
      type: restType,
      defaultValue,
      prompt: prompts[name] ?? "",
    };
  });
}

function parseVariables(lines: string[]): ProcessVariable[] {
  const prologIdx = lines.findIndex((l) => /^572,/.test(l));
  const pre = prologIdx === -1 ? lines : lines.slice(0, prologIdx);

  let names: string[] = [];
  let types: number[] = [];
  let positions: number[] = [];

  let i = 0;
  while (i < pre.length) {
    const m = pre[i]!.match(/^(577|578|579),(\d+)$/);
    if (m) {
      const code = m[1]!;
      const count = parseInt(m[2]!, 10);
      const data = pre.slice(i + 1, i + 1 + count);
      if (code === "577") names = data.map((l) => l.trim());
      else if (code === "578") types = data.map((l) => parseInt(l.trim(), 10) || 2);
      else if (code === "579") positions = data.map((l) => parseInt(l.trim(), 10) || 1);
      i += 1 + count;
      continue;
    }
    i++;
  }

  return names.map((name, idx) => {
    const proType = types[idx] ?? 2;
    const restType: "String" | "Numeric" = proType === 1 ? "Numeric" : "String";
    return {
      name,
      type: restType,
      position: positions[idx] ?? idx + 1,
    };
  });
}

function parseDataSource(lines: string[]): DataSource {
  const get = (code: string): string | undefined => {
    for (const line of lines) {
      if (line.startsWith(`${code},`)) return stripQuotes(lineValue(line));
    }
    return undefined;
  };

  const proType = (get("562") ?? "NULL").toUpperCase();
  const TYPE_MAP: Record<string, DataSource["type"]> = {
    NULL: "None",
    VIEW: "TM1CubeView",
    SUBSET: "TM1DimensionSubset",
    CHARACTERDELIMITED: "ASCII",
    ODBC: "ODBC",
  };
  const restType = TYPE_MAP[proType] ?? "None";

  if (restType === "None") return { type: "None" };

  const dsName = get("585") ?? "";
  const viewSubset = get("570") ?? "";

  if (restType === "TM1CubeView") {
    return {
      type: restType,
      dataSourceNameForServer: dsName,
      dataSourceNameForClient: dsName,
      view: viewSubset,
    };
  }
  if (restType === "TM1DimensionSubset") {
    return {
      type: restType,
      dataSourceNameForServer: dsName,
      dataSourceNameForClient: dsName,
      subset: viewSubset,
    };
  }

  const ds: DataSource = {
    type: restType,
    dataSourceNameForServer: dsName,
    dataSourceNameForClient: dsName,
  };
  if (restType === "ASCII") {
    ds.asciiDelimiterChar = get("567") ?? ",";
    ds.asciiQuoteCharacter = get("568") ?? '"';
    ds.asciiDecimalSeparator = get("588") ?? ".";
    ds.asciiThousandSeparator = get("589") ?? ",";
    const headerVal = get("569");
    if (headerVal !== undefined) ds.asciiHeaderRecords = parseInt(headerVal, 10) || 0;
  }
  if (restType === "ODBC") {
    const user = get("564");
    if (user) ds.userName = user;
  }
  return ds;
}

export function parseProFile(content: string): ParsedPro {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, ""));
  const sections = parseSections(lines);
  return {
    name: parseProcessName(lines),
    ...sections,
    parameters: parseParameters(lines),
    variables: parseVariables(lines),
    dataSource: parseDataSource(lines),
  };
}
