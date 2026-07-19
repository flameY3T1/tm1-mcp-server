// Process/TI-domain schemas: parameters, variables, code tabs, datasource,
// get/execute/diff/upsert/copy results plus .pro & git import/export shapes.
import { z } from "zod";

import { PARAM_TYPE } from "./items-common.js";

export const ProcessParameterSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

export const ProcessVariableSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  position: z.number().int(),
  startByte: z.number().int().optional(),
  endByte: z.number().int().optional(),
});

export const CompileErrorSchema = z.object({
  lineNumber: z.number().int().optional(),
  procedure: z.string().optional(),
  message: z.string(),
});

export const ProcessItemSchema = z.object({
  name: z.string(),
  // Omitted when caller passes fields=['name'] to tm1_list_processes for compact output.
  parameters: z.array(ProcessParameterSchema).optional(),
});

export const ProcessCodeSchema = z.object({
  prolog: z.string(),
  metadata: z.string(),
  data: z.string(),
  epilog: z.string(),
  hint: z.string().optional(),
});

export const DataSourceSchema = z
  .object({
    type: z.enum([
      "None",
      "TM1CubeView",
      "TM1DimensionSubset",
      "ASCII",
      "ODBC",
      "TM1Process",
    ]),
    dataSourceNameForServer: z.string().optional(),
    dataSourceNameForClient: z.string().optional(),
    asciiDelimiterType: z.string().optional(),
    asciiDelimiterChar: z.string().optional(),
    asciiQuoteCharacter: z.string().optional(),
    asciiHeaderRecords: z.number().int().optional(),
    asciiDecimalSeparator: z.string().optional(),
    asciiThousandSeparator: z.string().optional(),
    usesUnicode: z.boolean().optional(),
    userName: z.string().optional(),
    password: z.string().optional(),
    oDBCConnection: z.string().optional(),
    query: z.string().optional(),
    view: z.string().optional(),
    subset: z.string().optional(),
  })
  .passthrough();

// tm1_get_process — every section is gated by an include-flag, so all fields
// except `name` are optional. The code tabs sit at the TOP level (the handler
// spreads them into the payload), not under a `tabs` object.
export const GetProcessResultSchema = z.object({
  name: z.string(),
  prolog: z.string().optional(),
  metadata: z.string().optional(),
  data: z.string().optional(),
  epilog: z.string().optional(),
  parameters: z.array(ProcessParameterSchema).optional(),
  variables: z.array(ProcessVariableSchema).optional(),
  dataSource: DataSourceSchema.optional(),
  hasSecurityAccess: z.boolean().optional(),
  hint: z.string().optional(),
});

export const ProcessCodeBundleSchema = z.object({
  name: z.string(),
  hasSecurityAccess: z.boolean(),
  // Full mode (default): the four TI tab bodies verbatim (credentials masked
  // by default via maskSecrets).
  prolog: z.string().optional(),
  metadata: z.string().optional(),
  data: z.string().optional(),
  epilog: z.string().optional(),
  // Summary mode (tm1_get_all_processes_code summary=true): tab bodies are
  // replaced by aggregate line metrics so analysis agents can survey the
  // process landscape without paying full token cost.
  totalLines: z.number().int().optional(),
  prologLines: z.number().int().optional(),
  metadataLines: z.number().int().optional(),
  dataLines: z.number().int().optional(),
  epilogLines: z.number().int().optional(),
  commentLines: z.number().int().optional(),
});

export const ValidateProcessRefsResultSchema = z.object({
  processName: z.string().nullable(),
  cubeRefsScanned: z.number().int(),
  dimensionRefsScanned: z.number().int(),
  unresolved: z.number().int(),
  issues: z.array(z.unknown()),
});

export const ProcessResultSchema = z.object({
  success: z.boolean(),
  processErrorStatus: z.string(),
  errorLogFile: z.string().optional(),
});

// ── Phase 2d: diff/bundle/upsert ─────────────────────────────────────────────

export const DiffProcessResultSchema = z
  .object({
    processName: z.string(),
    identical: z.boolean(),
    tabs: z.unknown(),
    parameters: z.unknown(),
    variables: z.unknown(),
    dataSource: z.unknown(),
  })
  .passthrough();

export const UpsertProcessResultSchema = z
  .object({
    processName: z.string(),
    action: z.enum(["created", "updated"]),
    appliedSteps: z.array(z.string()),
  })
  .passthrough();

const InstallBundleEntrySchema = z
  .object({
    file: z.string().optional(),
    processName: z.string().nullable().optional(),
    status: z.string(),
  })
  .passthrough();

export const InstallProBundleResultSchema = z
  .object({
    directory: z.string(),
    filesFound: z.number().int(),
    dryRun: z.boolean().optional(),
    mode: z.string().optional(),
    counts: z
      .object({
        created: z.number().int(),
        updated: z.number().int(),
        preflight_failed: z.number().int(),
        error: z.number().int(),
        skipped: z.number().int(),
      })
      .optional(),
    results: z.array(InstallBundleEntrySchema),
  })
  .passthrough();

export const ImportProFileResultSchema = z.object({
  action: z.string(),
  processName: z.string(),
  parsed: z.object({
    prologLines: z.number().int(),
    metadataLines: z.number().int(),
    dataLines: z.number().int(),
    epilogLines: z.number().int(),
    parameterCount: z.number().int(),
    variableCount: z.number().int(),
    dataSourceType: z.string(),
  }),
});

// Dedicated schema for tm1_import_process_from_git. Currently identical in
// shape to ImportProFileResultSchema, but kept separate so the two import
// paths can diverge (e.g. a .pro-specific field) without one silently
// rejecting the other's payload. Mirror any git-import handler change here.
export const ImportProcessFromGitResultSchema = z.object({
  action: z.string(),
  processName: z.string(),
  hasSecurityAccess: z.boolean().optional(),
  parsed: z.object({
    prologLines: z.number().int(),
    metadataLines: z.number().int(),
    dataLines: z.number().int(),
    epilogLines: z.number().int(),
    parameterCount: z.number().int(),
    variableCount: z.number().int(),
    dataSourceType: z.string(),
  }),
});

export const CopyProcessResultSchema = z.object({
  success: z.boolean(),
  sourceName: z.string(),
  targetName: z.string(),
});

export const DiffProcessesResultSchema = z
  .object({
    processA: z.string(),
    processB: z.string(),
    identical: z.boolean(),
    tabs: z.unknown(),
    parameters: z.unknown(),
    variables: z.unknown(),
    dataSource: z.unknown(),
  })
  .passthrough();

export const ProcessesGroupedResultSchema = z.object({
  totalProcesses: z.number().int(),
  groupCount: z.number().int(),
  prefixSegments: z.number().int(),
  groups: z.array(
    z.object({
      prefix: z.string(),
      count: z.number().int(),
      processes: z.array(z.string()).optional(),
    }),
  ),
});

export const DiagnoseProcessErrorResultSchema = z.object({
  processName: z.string(),
  since: z.string().nullable(),
  logsFound: z.number().int(),
  logsReturned: z.number().int(),
  logs: z.array(z.unknown()),
});

export const ExportProcessToProResultSchema = z.object({
  processName: z.string(),
  byteLength: z.number().int(),
  writtenTo: z.string().nullable(),
  parameterCount: z.number().int(),
  variableCount: z.number().int(),
  dataSourceType: z.string(),
  content: z.string(),
});

export const ExportProcessToGitResultSchema = z.object({
  processName: z.string(),
  jsonFileName: z.string(),
  tiFileName: z.string(),
  parameterCount: z.number().int(),
  variableCount: z.number().int(),
  dataSourceType: z.string(),
  credentialsOmitted: z.boolean(),
  hasSecurityAccess: z.boolean(),
  writtenTo: z.object({
    json: z.string().nullable(),
    ti: z.string().nullable(),
  }),
  // Full file bodies are echoed inline only when writeToDir is NOT set; when
  // exporting to disk the caller already has the files, so we omit them to
  // avoid flooding the context window with duplicate code.
  json: z.string().optional(),
  ti: z.string().optional(),
});
