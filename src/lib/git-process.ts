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

type Tab = "prolog" | "metadata" | "data" | "epilog";

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

const TAB_NAMES: ReadonlySet<Tab> = new Set(["prolog", "metadata", "data", "epilog"]);

interface RegionMarker {
  kind: "region" | "endregion";
  /** Raw token right after the keyword (tab name for #region; usually empty for #endregion). */
  name: string;
  /** Index of the marker line's first character (including leading whitespace). */
  start: number;
  /** Index right after the marker line (where the following content, if any, begins). */
  contentStart: number;
}

/** Build a descriptive error naming the structural problem (same "reject, don't guess" shape
 *  as the pre-existing zero-region error below). */
function regionBlobError(problem: string): Error {
  return new Error(
    `TI file has a malformed #region/#endregion code blob: ${problem} ` +
      "Refusing to parse a structurally invalid blob (this would otherwise silently drop or " +
      "misattribute code). Re-export from the server, or fix the marker manually.",
  );
}

/** Scan every `#region`/`#endregion` marker line, in document order, top-level AND nested. */
function extractRegionMarkers(ti: string): RegionMarker[] {
  const markerRe = /^[ \t]*#(region|endregion)\b[ \t]*(\S*)[^\r\n]*\r?\n?/gim;
  const markers: RegionMarker[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = markerRe.exec(ti)) !== null) {
    markers.push({
      kind: mm[1]!.toLowerCase() as "region" | "endregion",
      name: mm[2]!,
      start: mm.index,
      contentStart: mm.index + mm[0].length,
    });
  }
  return markers;
}

/**
 * Parse a native `#region <Tab>` / `#endregion` code blob into the four tabs.
 * Case-insensitive on keyword and tab name; a tab whose region is absent
 * defaults to "". Throws if the blob has no region markers at all (rejects the
 * pre-1.x `### TM1-TI-TAB:` layout — no longer supported), and — critically —
 * throws on ANY structural violation instead of silently mis-parsing:
 *   - unbalanced #region/#endregion counts (e.g. a missing/typo'd #endregion,
 *     which would otherwise let the next tab's content get silently absorbed
 *     into the previous tab)
 *   - a nested/stray #region (e.g. an editor folding-region comment inside a
 *     tab's code), which would otherwise cause the parser to close on the
 *     FIRST #endregion it finds and silently drop everything after it
 * A well-formed blob must be a flat, non-nested sequence of top-level
 * `#region <KnownTab>` … `#endregion` pairs (arbitrary code content between
 * them is fine — only marker lines are structurally significant).
 */
function parseCodeBlob(ti: string): Record<Tab, string> {
  const out: Record<Tab, string> = { prolog: "", metadata: "", data: "", epilog: "" };
  const markers = extractRegionMarkers(ti);

  if (markers.length === 0) {
    throw new Error(
      "TI file has no #region markers (expected `#region Prolog` … `#endregion`). " +
        "Pre-1.x `### TM1-TI-TAB:` files are no longer supported — re-export from the server.",
    );
  }

  const regionCount = markers.filter((m) => m.kind === "region").length;
  const endregionCount = markers.length - regionCount;
  if (regionCount !== endregionCount) {
    throw regionBlobError(
      `found ${regionCount} #region marker(s) but ${endregionCount} #endregion marker(s) ` +
        "(unbalanced) — the blob is truncated or a closing #endregion is missing.",
    );
  }

  let found = 0;
  let i = 0;
  while (i < markers.length) {
    const opener = markers[i]!;
    if (opener.kind !== "region") {
      throw regionBlobError(
        `found a stray #endregion with no matching #region near offset ${opener.start}.`,
      );
    }
    const tabName = opener.name.toLowerCase();
    if (!TAB_NAMES.has(tabName as Tab)) {
      throw regionBlobError(
        `found "#region ${opener.name}" which is not a recognized TI tab ` +
          "(expected Prolog/Metadata/Data/Epilog) — this looks like a nested or stray #region " +
          "(e.g. an editor folding marker) inside a tab's code, which is not supported.",
      );
    }
    const closer = markers[i + 1];
    if (!closer || closer.kind !== "endregion") {
      throw regionBlobError(
        `"#region ${opener.name}" is missing its matching #endregion immediately after it — ` +
          "either the #endregion was dropped/mistyped, or another #region is nested inside it.",
      );
    }
    // Strip the single newline the server places before #endregion.
    out[tabName as Tab] = ti.slice(opener.contentStart, closer.start).replace(/\r?\n$/, "");
    found++;
    i += 2;
  }

  // Structurally unreachable given the checks above, but keep the original
  // invariant explicit rather than silently returning a default-filled `out`.
  if (found === 0) {
    throw regionBlobError("no valid #region <Tab> … #endregion pair was found.");
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
