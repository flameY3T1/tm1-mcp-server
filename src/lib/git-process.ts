import { z } from "zod";
import type {
  DataSource,
  ProcessParameter,
  ProcessVariable,
} from "../types.js";
import {
  parameterSchema,
  variableSchema,
  dataSourceSchema,
} from "./process-parts-schema.js";

/**
 * tm1-git two-file representation of a TI process.
 *
 * `{name}.json` holds the structure (parameters, variables, datasource,
 * hasSecurityAccess). `{name}.ti` holds the code as TM1's native `Code`
 * representation — `#region <Tab>` / `#endregion` blocks (CRLF, empty tabs
 * omitted), byte-identical to `GET /Processes('x')/Code/$value`. The `.ti`
 * blob is produced by the server, not built here; this module only parses it
 * back (for import preflight). The `.json` is built by serializeProcessToGit.
 *
 * Credentials: the ODBC `password` is never written to the .json. A committed
 * password would be a leaked secret; on import it is re-supplied out of band
 * (see `dataSourcePassword` on the import tool).
 */

export interface GitProcessInput {
  name: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
  hasSecurityAccess: boolean;
}

export interface GitProcessJson {
  json: string;
  /** True when an ODBC password was present and stripped from the JSON. */
  credentialsOmitted: boolean;
}

export interface ParsedGitProcess {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
  hasSecurityAccess?: boolean;
}

const TAB_ORDER = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TAB_ORDER)[number];

/**
 * Build only the `{name}.json` (structure). Field order mirrors TM1's OData
 * Process entity (Name, HasSecurityAccess, DataSource, then Parameters/
 * Variables); parameter objects follow OData order (Name, Prompt, Value, Type).
 * Order is cosmetic — parseProcessFromGit reads by key.
 */
export function serializeProcessToGit(input: GitProcessInput): GitProcessJson {
  const { password, ...dataSourceNoPwd } = input.dataSource;
  const credentialsOmitted = password !== undefined && password !== "";

  const json =
    JSON.stringify(
      {
        name: input.name,
        hasSecurityAccess: input.hasSecurityAccess,
        dataSource: dataSourceNoPwd,
        parameters: input.parameters.map((p) => ({
          name: p.name,
          ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
          value: p.defaultValue,
          type: p.type,
        })),
        variables: input.variables,
      },
      null,
      2,
    ) + "\n";

  return { json, credentialsOmitted };
}

/**
 * Parse a native `#region <Tab>` / `#endregion` code blob into the four tabs.
 * Case-insensitive on keyword and tab name; a tab whose region is absent
 * defaults to "". Throws if the blob has no region markers at all (rejects the
 * pre-1.x `### TM1-TI-TAB:` layout — no longer supported).
 */
function parseCodeBlob(ti: string): Record<Tab, string> {
  const out: Record<Tab, string> = { prolog: "", metadata: "", data: "", epilog: "" };
  const re =
    /^[ \t]*#region[ \t]+(prolog|metadata|data|epilog)\b[^\r\n]*\r?\n([\s\S]*?)^[ \t]*#endregion\b[^\r\n]*$/gim;
  let m: RegExpExecArray | null;
  let found = 0;
  while ((m = re.exec(ti)) !== null) {
    const tab = m[1]!.toLowerCase() as Tab;
    // Strip the single newline the server places before #endregion.
    out[tab] = m[2]!.replace(/\r?\n$/, "");
    found++;
  }
  if (found === 0) {
    throw new Error(
      "TI file has no #region markers (expected `#region Prolog` … `#endregion`). " +
        "Pre-1.x `### TM1-TI-TAB:` files are no longer supported — re-export from the server.",
    );
  }
  return out;
}

/** Parse a `{name}.json` + `{name}.ti` pair back into deployable process parts. */
export function parseProcessFromGit(
  jsonContent: string,
  tiContent: string,
): ParsedGitProcess {
  let meta: {
    name?: unknown;
    hasSecurityAccess?: unknown;
    parameters?: unknown;
    variables?: unknown;
    dataSource?: unknown;
  };
  try {
    meta = JSON.parse(jsonContent) as typeof meta;
  } catch {
    throw new Error("Process JSON is not valid JSON");
  }

  const name = typeof meta.name === "string" ? meta.name : "";
  const hasSecurityAccess =
    typeof meta.hasSecurityAccess === "boolean" ? meta.hasSecurityAccess : undefined;

  // Git .json uses the OData-native param field name `value`; the internal
  // schema uses `defaultValue`. Normalize value→defaultValue before validation,
  // keeping back-compat with legacy files that wrote `defaultValue`.
  const rawParams = Array.isArray(meta.parameters)
    ? meta.parameters.map((p) => {
        if (p && typeof p === "object" && "value" in p && !("defaultValue" in p)) {
          const { value, ...rest } = p as Record<string, unknown>;
          return { ...rest, defaultValue: value };
        }
        return p;
      })
    : (meta.parameters ?? []);

  const paramsResult = z.array(parameterSchema).safeParse(rawParams);
  if (!paramsResult.success) {
    throw new Error(
      `Process JSON has invalid 'parameters': ${paramsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const parameters: ProcessParameter[] = paramsResult.data;

  const varsResult = z.array(variableSchema).safeParse(meta.variables ?? []);
  if (!varsResult.success) {
    throw new Error(
      `Process JSON has invalid 'variables': ${varsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const variables: ProcessVariable[] = varsResult.data;

  const dsResult = dataSourceSchema.safeParse(meta.dataSource ?? { type: "None" });
  if (!dsResult.success) {
    throw new Error(
      `Process JSON has invalid 'dataSource': ${dsResult.error.issues[0]?.message ?? "shape mismatch"}`,
    );
  }
  const dataSource: DataSource = dsResult.data;

  const tabs = parseCodeBlob(tiContent);

  return {
    name,
    ...(hasSecurityAccess !== undefined ? { hasSecurityAccess } : {}),
    prolog: tabs.prolog,
    metadata: tabs.metadata,
    data: tabs.data,
    epilog: tabs.epilog,
    parameters,
    variables,
    dataSource,
  };
}
