import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../types.js";

export interface ProcessSerializeInput {
  name: string;
  prolog?: string;
  metadata?: string;
  data?: string;
  epilog?: string;
  parameters?: ProcessParameter[];
  variables?: ProcessVariable[];
  dataSource?: DataSource;
}

// Quote-and-escape a string for .pro CSV-like values: wrap in double quotes, double inner ".
function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function paramTypeToInt(t: ProcessParameter["type"]): number {
  return t === "String" ? 2 : 1;
}

function variableTypeToInt(t: ProcessVariable["type"]): number {
  return t === "Numeric" ? 1 : 2;
}

function serializeParameters(params: ProcessParameter[]): string[] {
  if (params.length === 0) return [];
  const lines: string[] = [];
  // 560 = parameter names
  lines.push(`560,${params.length}`);
  for (const p of params) lines.push(p.name);
  // 561 = parameter types (1=Numeric, 2=String)
  lines.push(`561,${params.length}`);
  for (const p of params) lines.push(String(paramTypeToInt(p.type)));
  // 590 = name,defaultValue (numbers raw, strings quoted)
  lines.push(`590,${params.length}`);
  for (const p of params) {
    const dv = p.defaultValue;
    const valStr =
      typeof dv === "number" ? String(dv) : quote(String(dv ?? ""));
    lines.push(`${p.name},${valStr}`);
  }
  // 637 = name,prompt
  lines.push(`637,${params.length}`);
  for (const p of params) lines.push(`${p.name},${quote(p.prompt ?? "")}`);
  return lines;
}

function serializeVariables(vars: ProcessVariable[]): string[] {
  if (vars.length === 0) return [];
  const lines: string[] = [];
  lines.push(`577,${vars.length}`);
  for (const v of vars) lines.push(v.name);
  lines.push(`578,${vars.length}`);
  for (const v of vars) lines.push(String(variableTypeToInt(v.type)));
  lines.push(`579,${vars.length}`);
  for (const v of vars) lines.push(String(v.position));
  return lines;
}

function serializeDataSource(ds: DataSource | undefined): string[] {
  if (!ds || ds.type === "None") return ["562,NULL"];
  const REVERSE_TYPE_MAP: Record<DataSource["type"], string> = {
    None: "NULL",
    TM1CubeView: "VIEW",
    TM1DimensionSubset: "SUBSET",
    ASCII: "CHARACTERDELIMITED",
    ODBC: "ODBC",
    TM1Process: "TM1PROCESS",
  };
  const lines: string[] = [];
  // A fixed-width ASCII source is its own .pro type, not a flag on the type.
  const proType =
    ds.type === "ASCII" && ds.asciiDelimiterType === "FixedWidth"
      ? "POSITIONDELIMITED"
      : REVERSE_TYPE_MAP[ds.type];
  lines.push(`562,${quote(proType)}`);
  // 586 = DataSourceNameForServer, 585 = DataSourceNameForClient — this is the
  // slot order TM1 itself writes; each falls back to the other when unset.
  const server = ds.dataSourceNameForServer ?? ds.dataSourceNameForClient ?? "";
  // TM1 leaves 585 empty when no client-side name is set — mirror that rather
  // than duplicating the server name, which would alter state on re-import.
  const client = ds.dataSourceNameForClient ?? "";
  lines.push(`586,${quote(server)}`);
  lines.push(`585,${quote(client)}`);

  // View and subset names go in unquoted — TM1 writes `570,Ansicht, mit "Komma"`
  // verbatim, commas and quotes included.
  if (ds.type === "TM1CubeView") {
    lines.push(`570,${ds.view ?? ""}`);
  } else if (ds.type === "TM1DimensionSubset") {
    // 571 is the subset slot; 570 holds view names.
    lines.push(`571,${ds.subset ?? ""}`);
  } else if (ds.type === "ASCII") {
    if (ds.asciiDelimiterChar !== undefined)
      lines.push(`567,${quote(ds.asciiDelimiterChar)}`);
    if (ds.asciiQuoteCharacter !== undefined)
      lines.push(`568,${quote(ds.asciiQuoteCharacter)}`);
    if (ds.asciiHeaderRecords !== undefined)
      lines.push(`569,${ds.asciiHeaderRecords}`);
    if (ds.asciiDecimalSeparator !== undefined)
      lines.push(`588,${quote(ds.asciiDecimalSeparator)}`);
    if (ds.asciiThousandSeparator !== undefined)
      lines.push(`589,${quote(ds.asciiThousandSeparator)}`);
  } else if (ds.type === "ODBC") {
    if (ds.userName) lines.push(`564,${quote(ds.userName)}`);
    // 566 is a counted block: header with the line count, then the SQL. TM1
    // writes "566,0" when there is no query. The password (565) stays out —
    // TM1 stores it as a server-encrypted blob, useless and unsafe to carry.
    const queryLines =
      ds.query !== undefined && ds.query.length > 0
        ? ds.query.split(/\r?\n/)
        : [];
    lines.push(`566,${queryLines.length}`);
    lines.push(...queryLines);
  }
  return lines;
}

function serializeSection(
  code: "572" | "573" | "574" | "575",
  body: string | undefined,
): string[] {
  const text = body ?? "";
  const bodyLines = text.length > 0 ? text.split(/\r?\n/) : [];
  // Line count in the header, like TM1: it keeps code that looks like a header
  // line (e.g. a literal "930,0") inside the section on re-read.
  return [`${code},${bodyLines.length}`, ...bodyLines];
}

// Serialize a TM1 process back to a .pro file body. Round-trip safe with parseProFile().
// Line codes follow what TM1 writes itself (562/564/566/570/571/585/586, counted
// sections), so files TM1 wrote parse back losslessly. Still omitted are the headers
// TM1 adds but that carry no portable information: 601 (version), 559, 565 (the
// server-encrypted password blob), 592, 593-598, 599, 800/801, 928, 603. They are only
// required when re-uploading via legacy TM1 .pro tooling, not for repo round-trip via
// tm1_import_pro_file.
export function serializeToPro(input: ProcessSerializeInput): string {
  const lines: string[] = [];
  lines.push(`602,${quote(input.name)}`);
  lines.push(...serializeParameters(input.parameters ?? []));
  lines.push(...serializeVariables(input.variables ?? []));
  lines.push(...serializeDataSource(input.dataSource));
  lines.push(...serializeSection("572", input.prolog));
  lines.push(...serializeSection("573", input.metadata));
  lines.push(...serializeSection("574", input.data));
  lines.push(...serializeSection("575", input.epilog));
  // Trailing newline — TM1 .pro files end with one.
  return lines.join("\n") + "\n";
}
