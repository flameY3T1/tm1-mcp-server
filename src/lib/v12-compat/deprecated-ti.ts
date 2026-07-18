// Canonical list of TI functions removed in TM1 / Planning Analytics v12
// (Cloud Native engine).
//
// Source of truth: vscode-tm1-ti repo, src/tiLogicVisualizer/tiSignatures.ts
// Synced from commit cf73b93 ("fix(webview): robust Ctrl+V paste path + ...")
// on 2026-05-12. Each entry there carries a `deprecatedInV12: true` flag.
//
// Sync procedure: when IBM publishes new PA Cloud release notes or the
// upstream signatures file changes, re-extract from vscode-tm1-ti's
// tiSignatures.ts (entries flagged `deprecatedInV12: true`) and update the
// list below, bumping the source commit reference above.

export interface DeprecatedTiEntry {
  /** Canonical name, original casing (e.g. "SaveDataAll"). */
  name: string;
  /** Short rationale — surfaced as `issue` in findings. */
  issue: string;
  /** Migration hint or "remove without replacement" when no replacement exists. */
  suggestion: string;
  /** Severity bucket. "error" = removed, "warning" = behavior-changed/cloud-only. */
  severity: "error" | "warning";
}

// Keyed by lowercase name (TI is case-insensitive).
export const V12_DEPRECATED_TI: ReadonlyMap<string, DeprecatedTiEntry> = new Map(
  [
    { name: "AddInfoCubeRestriction", severity: "error",
      issue: "Cube restriction API removed in v12 — security moves to Cloud IAM",
      suggestion: "Configure via Cloud admin or PA Workspace security" },
    { name: "AllowExternalRequests", severity: "error",
      issue: "External-request toggle removed in v12",
      suggestion: "Remove without replacement — external calls go through the PA connector layer" },
    { name: "AssignClientPassword", severity: "error",
      issue: "TI-based password management removed in v12",
      suggestion: "Manage identity via Cloud IAM/SCIM" },
    { name: "AssociateCAMIDToGroup", severity: "error",
      issue: "CAM security mapping via TI no longer supported in v12",
      suggestion: "Maintain group mapping via Cloud admin" },
    { name: "BatchCellIncrement", severity: "error",
      issue: "Batch cell API removed in v12",
      suggestion: "Use a regular CellPutN/CellIncrementN loop" },
    { name: "BatchUpdateFinish", severity: "error",
      issue: "BatchUpdate mode removed in v12 — the cloud engine optimizes automatically",
      suggestion: "Remove without replacement" },
    { name: "BatchUpdateFinishWait", severity: "error",
      issue: "BatchUpdate mode removed in v12",
      suggestion: "Remove without replacement" },
    { name: "BatchUpdateStart", severity: "error",
      issue: "BatchUpdate mode removed in v12",
      suggestion: "Remove without replacement" },
    { name: "CGAddPromptValues", severity: "error",
      issue: "Cognos Gateway prompts removed in v12",
      suggestion: "Remodel the workflow in PA Workspace" },
    { name: "CGPromptGetNextMember", severity: "error",
      issue: "Cognos Gateway prompts removed in v12",
      suggestion: "Remodel the workflow in PA Workspace" },
    { name: "CGPromptSize", severity: "error",
      issue: "Cognos Gateway prompts removed in v12",
      suggestion: "Remodel the workflow in PA Workspace" },
    { name: "CreateHierarchyByAttribute", severity: "error",
      issue: "Auto hierarchy builder removed in v12",
      suggestion: "Build the hierarchy manually via REST API/TI loop" },
    { name: "CubeDataReservationAcquire", severity: "error",
      issue: "Data reservation API removed in v12",
      suggestion: "Model locking via process lock / sandbox workflow" },
    { name: "CubeDataReservationGet", severity: "error",
      issue: "Data reservation API removed in v12",
      suggestion: "Model locking via process lock / sandbox workflow" },
    { name: "CubeDataReservationGetConflicts", severity: "error",
      issue: "Data reservation API removed in v12",
      suggestion: "Model locking via process lock / sandbox workflow" },
    { name: "CubeDataReservationRelease", severity: "error",
      issue: "Data reservation API removed in v12",
      suggestion: "Model locking via process lock / sandbox workflow" },
    { name: "CubeDataReservationReleaseAll", severity: "error",
      issue: "Data reservation API removed in v12",
      suggestion: "Model locking via process lock / sandbox workflow" },
    { name: "CubeGetLogChanges", severity: "error",
      issue: "Cube LogChanges toggle removed in v12 — logging is centralized",
      suggestion: "Remove without replacement" },
    { name: "CubeSaveData", severity: "error",
      issue: "Manual persistence removed in v12 — the cloud engine persists automatically",
      suggestion: "Remove without replacement" },
    { name: "CubeSetConnParams", severity: "error",
      issue: "Connection params via TI removed in v12",
      suggestion: "Configure data sources via the admin UI" },
    { name: "CubeSetLogChanges", severity: "error",
      issue: "Cube LogChanges toggle removed in v12",
      suggestion: "Remove without replacement" },
    { name: "CubeUnload", severity: "error",
      issue: "Cube unload via TI removed in v12",
      suggestion: "Use tm1_unload_cube via REST or remove without replacement" },
    { name: "DisableBulkLoadMode", severity: "error",
      issue: "BulkLoad mode removed in v12",
      suggestion: "Remove without replacement — the cloud engine optimizes automatically" },
    { name: "EnableBatchCellIncrement", severity: "error",
      issue: "Batch cell API removed in v12",
      suggestion: "Remove without replacement" },
    { name: "EnableBulkLoadMode", severity: "error",
      issue: "BulkLoad mode removed in v12",
      suggestion: "Remove without replacement — the cloud engine optimizes automatically" },
    { name: "ExecuteCommand", severity: "error",
      issue: "Shell execution removed in v12 (cloud sandbox allows no OS calls)",
      suggestion: "Orchestrate external steps via CI/CD/PA connector" },
    { name: "ExecuteJavaN", severity: "error",
      issue: "Java bridge removed in v12",
      suggestion: "Port the logic to TI/rules or use an external service" },
    { name: "ExecuteJavaS", severity: "error",
      issue: "Java bridge removed in v12",
      suggestion: "Port the logic to TI/rules or use an external service" },
    { name: "LockOff", severity: "error",
      issue: "TI lock toggle removed in v12",
      suggestion: "Remove without replacement — locking via the sandbox model" },
    { name: "LockOn", severity: "error",
      issue: "TI lock toggle removed in v12",
      suggestion: "Remove without replacement — locking via the sandbox model" },
    { name: "RefreshMDXHierarchy", severity: "error",
      issue: "MDX refresh hook removed in v12",
      suggestion: "Remove without replacement — the engine refreshes automatically" },
    { name: "RemoveCAMIDAssociation", severity: "error",
      issue: "CAM security mapping via TI no longer supported in v12",
      suggestion: "Maintain mapping via Cloud admin" },
    { name: "RemoveCAMIDAssociationFromGroup", severity: "error",
      issue: "CAM security mapping via TI no longer supported in v12",
      suggestion: "Maintain mapping via Cloud admin" },
    { name: "SaveDataAll", severity: "error",
      issue: "SaveDataAll removed in v12 — the cloud engine persists automatically",
      suggestion: "Remove without replacement" },
    { name: "ServerShutdown", severity: "error",
      issue: "Server shutdown via TI removed in v12 (cloud-managed)",
      suggestion: "Remove without replacement" },
    { name: "SetChoreVerboseMessages", severity: "warning",
      issue: "Chore verbose toggle removed in v12",
      suggestion: "Consume logging via central logs" },
    { name: "SetOdbcUnicodeInterface", severity: "error",
      issue: "ODBC data sources removed in v12 — external connector required",
      suggestion: "Connect data via PA cloud connector / Files API" },
    { name: "SwapAliasWithPrincipalName", severity: "error",
      issue: "Alias swap helper removed in v12",
      suggestion: "Model explicitly via AttributePutS() operations" },
  ].map((e): [string, DeprecatedTiEntry] => [e.name.toLowerCase(), e as DeprecatedTiEntry]),
);

/**
 * Combined case-insensitive regex matching any deprecated function name
 * followed by `(`. Used by the scanner for a single-pass-per-line match.
 */
export const V12_DEPRECATED_TI_REGEX: RegExp = (() => {
  const alternation = Array.from(V12_DEPRECATED_TI.values())
    .map((e) => e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  return new RegExp(`\\b(${alternation})\\s*\\(`, "gi");
})();
