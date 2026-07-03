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
 * tm1-git-style two-file representation of a TI process.
 *
 * TM1's native Git integration serializes each process to a `{name}.json`
 * (structure: parameters, variables, datasource) plus a `{name}.ti` (the four
 * procedure tabs as plain code). Splitting the code out of the JSON keeps Git
 * diffs readable — escaped-newline code blobs inside JSON are unreviewable.
 *
 * This module produces that pair and parses it back. The round-trip is lossless
 * with `tm1_import_process_from_git` (line endings are normalized to LF, which is
 * the correct, diff-stable form for a Git working tree). It is NOT byte-identical
 * to IBM's internal serializer — the tab markers below are our own, documented
 * convention.
 *
 * Credentials: like the `.pro` serializer, the ODBC `password` is never written to
 * the JSON. A committed password is a leaked secret. On import the password must be
 * re-supplied out of band (see `dataSourcePassword` on the import tool).
 */

export interface GitProcessInput {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  parameters: ProcessParameter[];
  variables: ProcessVariable[];
  dataSource: DataSource;
  hasSecurityAccess: boolean;
  caption?: string;
}

export interface GitProcessFiles {
  json: string;
  ti: string;
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
  hasSecurityAccess: boolean;
  caption?: string;
}

const TAB_ORDER = ["prolog", "metadata", "data", "epilog"] as const;
type Tab = (typeof TAB_ORDER)[number];

const tabMarker = (tab: Tab): string => `### TM1-TI-TAB: ${tab} ###`;
const TAB_LINE_RE = /^### TM1-TI-TAB: (prolog|metadata|data|epilog) ###\s*$/;

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Serialize a process into the json + ti file pair. */
export function serializeProcessToGit(input: GitProcessInput): GitProcessFiles {
  // --- .ti: four tabs, each behind a marker line ---
  const lines: string[] = [];
  for (const tab of TAB_ORDER) {
    lines.push(tabMarker(tab));
    const content = normalizeNewlines(input[tab] ?? "");
    if (content.length > 0) lines.push(...content.split("\n"));
  }
  const ti = lines.join("\n") + "\n";

  // --- .json: structure only, password stripped ---
  const { password, ...dataSourceNoPwd } = input.dataSource;
  const credentialsOmitted = password !== undefined && password !== "";

  const json =
    JSON.stringify(
      {
        name: input.name,
        hasSecurityAccess: input.hasSecurityAccess,
        ...(input.caption ? { caption: input.caption } : {}),
        parameters: input.parameters,
        variables: input.variables,
        dataSource: dataSourceNoPwd,
      },
      null,
      2,
    ) + "\n";

  return { json, ti, credentialsOmitted };
}

/** Parse a json + ti file pair back into deployable process parts. */
export function parseProcessFromGit(
  jsonContent: string,
  tiContent: string,
): ParsedGitProcess {
  let meta: {
    name?: unknown;
    hasSecurityAccess?: unknown;
    caption?: unknown;
    parameters?: unknown;
    variables?: unknown;
    dataSource?: unknown;
  };
  try {
    meta = JSON.parse(jsonContent) as typeof meta;
  } catch (err) {
    throw new Error(
      `Process JSON is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }

  const name = typeof meta.name === "string" ? meta.name : "";

  const hasSecurityAccess =
    typeof meta.hasSecurityAccess === "boolean" ? meta.hasSecurityAccess : false;
  const caption = typeof meta.caption === "string" && meta.caption.length > 0
    ? meta.caption
    : undefined;

  // Validate the deployable parts instead of blind-casting user JSON: a
  // malformed entry (e.g. type:"bad" or a numeric name) would otherwise flow
  // straight into encodeParameter / the REST payload and surface as a confusing
  // TM1 400. Missing/absent parts still default to empty / {type:"None"}.
  const paramsResult = z.array(parameterSchema).safeParse(meta.parameters ?? []);
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

  // --- split .ti by tab markers ---
  const buckets: Record<Tab, string[]> = {
    prolog: [],
    metadata: [],
    data: [],
    epilog: [],
  };
  let current: Tab | null = null;
  let sawMarker = false;
  for (const raw of normalizeNewlines(tiContent).split("\n")) {
    const m = raw.match(TAB_LINE_RE);
    if (m) {
      current = m[1] as Tab;
      sawMarker = true;
      continue;
    }
    if (current) buckets[current].push(raw);
  }
  if (!sawMarker) {
    throw new Error(
      "TI file has no tab markers (### TM1-TI-TAB: prolog ### ...); not a tm1-git .ti file",
    );
  }

  // Trim the single trailing empty line introduced by the serializer's final "\n".
  for (const tab of TAB_ORDER) {
    const arr = buckets[tab];
    if (arr.length > 0 && arr[arr.length - 1] === "") arr.pop();
  }

  return {
    name,
    hasSecurityAccess,
    ...(caption !== undefined ? { caption } : {}),
    prolog: buckets.prolog.join("\n"),
    metadata: buckets.metadata.join("\n"),
    data: buckets.data.join("\n"),
    epilog: buckets.epilog.join("\n"),
    parameters,
    variables,
    dataSource,
  };
}
