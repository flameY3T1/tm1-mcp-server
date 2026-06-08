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
  /** Short rationale in German — surfaced as `issue` in findings. */
  issue: string;
  /** Migration hint or "ersatzlos entfernen" when no replacement exists. */
  suggestion: string;
  /** Severity bucket. "error" = removed, "warning" = behavior-changed/cloud-only. */
  severity: "error" | "warning";
}

// Keyed by lowercase name (TI is case-insensitive).
export const V12_DEPRECATED_TI: ReadonlyMap<string, DeprecatedTiEntry> = new Map(
  [
    { name: "AddInfoCubeRestriction", severity: "error",
      issue: "Cube-Restriction-API in v12 entfernt — Security wandert in Cloud-IAM",
      suggestion: "Über Cloud-Admin oder PA Workspace Security konfigurieren" },
    { name: "AllowExternalRequests", severity: "error",
      issue: "External-request Toggle in v12 entfernt",
      suggestion: "Ersatzlos entfernen — externe Aufrufe laufen über PA-Connector-Layer" },
    { name: "AssignClientPassword", severity: "error",
      issue: "TI-basierte Passwort-Verwaltung in v12 entfernt",
      suggestion: "Identity über Cloud-IAM/SCIM verwalten" },
    { name: "AssociateCAMIDToGroup", severity: "error",
      issue: "CAM-Security-Mapping über TI in v12 nicht mehr unterstützt",
      suggestion: "Group-Mapping über Cloud-Admin pflegen" },
    { name: "BatchCellIncrement", severity: "error",
      issue: "Batch-Cell-API in v12 entfernt",
      suggestion: "Reguläre CellPutN/CellIncrementN-Schleife verwenden" },
    { name: "BatchUpdateFinish", severity: "error",
      issue: "BatchUpdate-Mode in v12 entfernt — Cloud-Engine optimiert automatisch",
      suggestion: "Ersatzlos entfernen" },
    { name: "BatchUpdateFinishWait", severity: "error",
      issue: "BatchUpdate-Mode in v12 entfernt",
      suggestion: "Ersatzlos entfernen" },
    { name: "BatchUpdateStart", severity: "error",
      issue: "BatchUpdate-Mode in v12 entfernt",
      suggestion: "Ersatzlos entfernen" },
    { name: "CGAddPromptValues", severity: "error",
      issue: "Cognos-Gateway-Prompts in v12 entfernt",
      suggestion: "Workflow über PA Workspace neu modellieren" },
    { name: "CGPromptGetNextMember", severity: "error",
      issue: "Cognos-Gateway-Prompts in v12 entfernt",
      suggestion: "Workflow über PA Workspace neu modellieren" },
    { name: "CGPromptSize", severity: "error",
      issue: "Cognos-Gateway-Prompts in v12 entfernt",
      suggestion: "Workflow über PA Workspace neu modellieren" },
    { name: "CreateHierarchyByAttribute", severity: "error",
      issue: "Auto-Hierarchy-Builder in v12 entfernt",
      suggestion: "Hierarchie manuell über REST-API/TI-Loop aufbauen" },
    { name: "CubeDataReservationAcquire", severity: "error",
      issue: "Data-Reservation-API in v12 entfernt",
      suggestion: "Locking über Process-Lock / Sandbox-Workflow modellieren" },
    { name: "CubeDataReservationGet", severity: "error",
      issue: "Data-Reservation-API in v12 entfernt",
      suggestion: "Locking über Process-Lock / Sandbox-Workflow modellieren" },
    { name: "CubeDataReservationGetConflicts", severity: "error",
      issue: "Data-Reservation-API in v12 entfernt",
      suggestion: "Locking über Process-Lock / Sandbox-Workflow modellieren" },
    { name: "CubeDataReservationRelease", severity: "error",
      issue: "Data-Reservation-API in v12 entfernt",
      suggestion: "Locking über Process-Lock / Sandbox-Workflow modellieren" },
    { name: "CubeDataReservationReleaseAll", severity: "error",
      issue: "Data-Reservation-API in v12 entfernt",
      suggestion: "Locking über Process-Lock / Sandbox-Workflow modellieren" },
    { name: "CubeGetLogChanges", severity: "error",
      issue: "Cube-LogChanges-Toggle in v12 entfernt — Logging zentral",
      suggestion: "Ersatzlos entfernen" },
    { name: "CubeSaveData", severity: "error",
      issue: "Manuelle Persistenz in v12 entfernt — Cloud-Engine persistiert automatisch",
      suggestion: "Ersatzlos entfernen" },
    { name: "CubeSetConnParams", severity: "error",
      issue: "Conn-Params über TI in v12 entfernt",
      suggestion: "Datenquellen-Config über Admin-UI" },
    { name: "CubeSetLogChanges", severity: "error",
      issue: "Cube-LogChanges-Toggle in v12 entfernt",
      suggestion: "Ersatzlos entfernen" },
    { name: "CubeUnload", severity: "error",
      issue: "Cube-Unload über TI in v12 entfernt",
      suggestion: "tm1_unload_cube über REST nutzen oder ersatzlos entfernen" },
    { name: "DisableBulkLoadMode", severity: "error",
      issue: "BulkLoad-Mode in v12 entfernt",
      suggestion: "Ersatzlos entfernen — Cloud-Engine optimiert automatisch" },
    { name: "EnableBatchCellIncrement", severity: "error",
      issue: "Batch-Cell-API in v12 entfernt",
      suggestion: "Ersatzlos entfernen" },
    { name: "EnableBulkLoadMode", severity: "error",
      issue: "BulkLoad-Mode in v12 entfernt",
      suggestion: "Ersatzlos entfernen — Cloud-Engine optimiert automatisch" },
    { name: "ExecuteCommand", severity: "error",
      issue: "Shell-Ausführung in v12 entfernt (Cloud-Sandbox erlaubt keine OS-Calls)",
      suggestion: "Externe Schritte über CI/CD/PA-Connector orchestrieren" },
    { name: "ExecuteJavaN", severity: "error",
      issue: "Java-Bridge in v12 entfernt",
      suggestion: "Logik in TI/Rules portieren oder externen Service nutzen" },
    { name: "ExecuteJavaS", severity: "error",
      issue: "Java-Bridge in v12 entfernt",
      suggestion: "Logik in TI/Rules portieren oder externen Service nutzen" },
    { name: "LockOff", severity: "error",
      issue: "TI-Lock-Toggle in v12 entfernt",
      suggestion: "Ersatzlos entfernen — Locking über Sandbox-Modell" },
    { name: "LockOn", severity: "error",
      issue: "TI-Lock-Toggle in v12 entfernt",
      suggestion: "Ersatzlos entfernen — Locking über Sandbox-Modell" },
    { name: "RefreshMDXHierarchy", severity: "error",
      issue: "MDX-Refresh-Hook in v12 entfernt",
      suggestion: "Ersatzlos entfernen — Engine refresh automatisch" },
    { name: "RemoveCAMIDAssociation", severity: "error",
      issue: "CAM-Security-Mapping über TI in v12 nicht mehr unterstützt",
      suggestion: "Mapping über Cloud-Admin pflegen" },
    { name: "RemoveCAMIDAssociationFromGroup", severity: "error",
      issue: "CAM-Security-Mapping über TI in v12 nicht mehr unterstützt",
      suggestion: "Mapping über Cloud-Admin pflegen" },
    { name: "SaveDataAll", severity: "error",
      issue: "SaveDataAll in v12 entfernt — Cloud-Engine persistiert automatisch",
      suggestion: "Ersatzlos entfernen" },
    { name: "ServerShutdown", severity: "error",
      issue: "Server-Shutdown über TI in v12 entfernt (Cloud-managed)",
      suggestion: "Ersatzlos entfernen" },
    { name: "SetChoreVerboseMessages", severity: "warning",
      issue: "Chore-Verbose-Toggle in v12 entfernt",
      suggestion: "Logging über zentrale Logs konsumieren" },
    { name: "SetOdbcUnicodeInterface", severity: "error",
      issue: "ODBC-Datenquellen in v12 entfernt — externe Connector erforderlich",
      suggestion: "Datenanbindung über PA-Cloud-Connector / Files-API" },
    { name: "SwapAliasWithPrincipalName", severity: "error",
      issue: "Alias-Swap-Helper in v12 entfernt",
      suggestion: "Über AttributePutS()-Operationen explizit modellieren" },
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
