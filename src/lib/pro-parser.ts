import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../types.js";

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

// Header codes whose value is a counted block ("560,3" + 3 lines), not a scalar.
// 566 is the ODBC query — TM1 writes "566,0" for every non-ODBC datasource.
const BLOCK_CODES = new Set([
  "560",
  "561",
  "566",
  "577",
  "578",
  "579",
  "580",
  "581",
  "582",
  "590",
  "637",
]);

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

interface HeaderFields {
  scalars: Map<string, string>;
  blocks: Map<string, string[]>;
}

// Read everything before the first code section into scalars ("585,\"DSN\"") and
// counted blocks ("566,3" + 3 lines). Consuming blocks by their count matters:
// an ODBC query line such as `FROM dbo."570,Sales"` must not be read as a header.
function parseHeaderFields(lines: string[]): HeaderFields {
  const scalars = new Map<string, string>();
  const blocks = new Map<string, string[]>();
  const sectionIdx = lines.findIndex((l) => SECTION_RE.test(l));
  const pre = sectionIdx === -1 ? lines : lines.slice(0, sectionIdx);

  let i = 0;
  while (i < pre.length) {
    const line = pre[i]!;
    const block = line.match(/^(\d{3}),(\d+)$/);
    if (block && BLOCK_CODES.has(block[1]!)) {
      const count = parseInt(block[2]!, 10);
      blocks.set(block[1]!, pre.slice(i + 1, i + 1 + count));
      i += 1 + count;
      continue;
    }
    const m = line.match(/^(\d{3}),/);
    // First occurrence wins, mirroring the old first-match lookup.
    if (m && !scalars.has(m[1]!))
      scalars.set(m[1]!, stripQuotes(lineValue(line)));
    i++;
  }
  return { scalars, blocks };
}

function parseSections(lines: string[]): {
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
} {
  const map: Record<string, string[]> = {
    "572": [],
    "573": [],
    "574": [],
    "575": [],
  };

  let i = 0;
  while (i < lines.length) {
    const m = lines[i]!.match(SECTION_RE);
    if (!m) {
      i++;
      continue;
    }
    const code = m[1]!;
    const rawCount = m[2]!;
    i++;
    if (rawCount !== "") {
      // TM1 writes an explicit line count ("572,138"). Trust it, so code lines
      // that look like a header (e.g. a literal "930,0") stay in the section.
      const count = parseInt(rawCount, 10);
      for (let taken = 0; taken < count && i < lines.length; taken++, i++) {
        map[code]!.push(lines[i]!);
      }
      continue;
    }
    // Countless header (older files written by this serializer): read until the
    // next numeric header line.
    while (i < lines.length && !/^\d{3},/.test(lines[i]!)) {
      map[code]!.push(lines[i]!);
      i++;
    }
  }

  return {
    prolog: map["572"]!.join("\n").trimEnd(),
    metadata: map["573"]!.join("\n").trimEnd(),
    data: map["574"]!.join("\n").trimEnd(),
    epilog: map["575"]!.join("\n").trimEnd(),
  };
}

function parseParameters(blocks: Map<string, string[]>): ProcessParameter[] {
  const names = (blocks.get("560") ?? []).map((l) => l.trim());
  const types = (blocks.get("561") ?? []).map(
    (l) => parseInt(l.trim(), 10) || 1,
  );
  const defaults: Record<string, string> = {};
  const prompts: Record<string, string> = {};

  for (const [code, target] of [
    ["590", defaults],
    ["637", prompts],
  ] as const) {
    for (const line of blocks.get(code) ?? []) {
      const ci = line.indexOf(",");
      if (ci === -1) continue;
      target[line.slice(0, ci)] = stripQuotes(line.slice(ci + 1));
    }
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

function parseVariables(blocks: Map<string, string[]>): ProcessVariable[] {
  const names = (blocks.get("577") ?? []).map((l) => l.trim());
  const types = (blocks.get("578") ?? []).map(
    (l) => parseInt(l.trim(), 10) || 2,
  );
  const positions = (blocks.get("579") ?? []).map(
    (l) => parseInt(l.trim(), 10) || 1,
  );

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

function parseDataSource(fields: HeaderFields): DataSource {
  const { scalars, blocks } = fields;
  const get = (code: string): string => scalars.get(code) ?? "";

  const proType = (get("562") || "NULL").toUpperCase();
  const TYPE_MAP: Record<string, DataSource["type"]> = {
    NULL: "None",
    VIEW: "TM1CubeView",
    SUBSET: "TM1DimensionSubset",
    CHARACTERDELIMITED: "ASCII",
    ODBC: "ODBC",
  };
  const restType = TYPE_MAP[proType] ?? "None";

  if (restType === "None") return { type: "None" };

  // 586 = DataSourceNameForServer, 585 = DataSourceNameForClient (verified
  // against .pro files TM1 wrote itself). Files written by this serializer
  // before that was known only carry 585, hence the fallback in both slots.
  const server = get("586") || get("585");
  const client = get("585") || server;

  if (restType === "TM1CubeView") {
    return {
      type: restType,
      dataSourceNameForServer: server,
      dataSourceNameForClient: client,
      view: get("570"),
    };
  }
  if (restType === "TM1DimensionSubset") {
    return {
      type: restType,
      dataSourceNameForServer: server,
      dataSourceNameForClient: client,
      // 571 holds the subset; 570 is the fallback for our own older files.
      subset: get("571") || get("570"),
    };
  }

  const ds: DataSource = {
    type: restType,
    dataSourceNameForServer: server,
    dataSourceNameForClient: client,
  };
  if (restType === "ASCII") {
    ds.asciiDelimiterChar = scalars.get("567") ?? ",";
    ds.asciiQuoteCharacter = scalars.get("568") ?? '"';
    ds.asciiDecimalSeparator = scalars.get("588") ?? ".";
    ds.asciiThousandSeparator = scalars.get("589") ?? ",";
    const headerVal = scalars.get("569");
    if (headerVal !== undefined)
      ds.asciiHeaderRecords = parseInt(headerVal, 10) || 0;
  }
  if (restType === "ODBC") {
    const user = get("564");
    if (user) ds.userName = user;
    const query = (blocks.get("566") ?? []).join("\n");
    if (query.length > 0) ds.query = query;
    // 565 holds the password as a server-encrypted blob that is worthless
    // anywhere else — it is deliberately not carried into the datasource.
  }
  return ds;
}

export function parseProFile(content: string): ParsedPro {
  const lines = content
    // TM1 writes .pro files with a UTF-8 BOM.
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""));
  const fields = parseHeaderFields(lines);
  const sections = parseSections(lines);
  return {
    name: parseProcessName(lines),
    ...sections,
    parameters: parseParameters(fields.blocks),
    variables: parseVariables(fields.blocks),
    dataSource: parseDataSource(fields),
  };
}
