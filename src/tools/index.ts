import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../tm1-client.js";

// Metadata tools
import { registerListCubes } from "./metadata/list-cubes.js";
import { registerListDimensions } from "./metadata/list-dimensions.js";
import { registerGetHierarchy } from "./metadata/get-hierarchy.js";
import { registerGetDescendants } from "./metadata/get-descendants.js";
import { registerGetAncestors } from "./metadata/get-ancestors.js";
import { registerResolveDefaultMembers } from "./metadata/resolve-default-members.js";
import { registerListProcesses } from "./metadata/list-processes.js";
import { registerListProcessesGrouped } from "./metadata/list-processes-grouped.js";
import { registerListChores } from "./metadata/list-chores.js";

// Cell data tools
import { registerGetCellValue } from "./celldata/get-cell-value.js";
import { registerExecuteMdx } from "./celldata/execute-mdx.js";
import { registerGetView } from "./celldata/get-view.js";
import { registerGetViewDefinition } from "./celldata/get-view-definition.js";
import { registerSampleCells } from "./celldata/sample-cells.js";
import { registerWriteCells } from "./celldata/write-cells.js";
import { registerCheckFeeders } from "./celldata/check-feeders.js";
import { registerTraceFeeders } from "./celldata/trace-feeders.js";
import { registerTraceCellCalculation } from "./celldata/trace-cell-calculation.js";

// TI development tools (process CRUD, execution, code, params, datasource)
import { registerExecuteProcess } from "./ti-development/execute-process.js";
import { registerGetProcessParameters } from "./ti-development/get-process-parameters.js";
import { registerGetProcessCode } from "./ti-development/get-process-code.js";
import { registerGetProcess } from "./ti-development/get-process.js";
import { registerGetProcessDatasource } from "./ti-development/get-process-datasource.js";
import { registerGetProcessVariables } from "./ti-development/get-process-variables.js";
import { registerDeleteProcess } from "./ti-development/delete-process.js";
import { registerCopyProcess } from "./ti-development/copy-process.js";
import { registerCompileProcess } from "./ti-development/compile-process.js";
import { registerCheckProcessCode } from "./ti-development/check-process-code.js";
import { registerGetAllProcessesCode } from "./ti-development/get-all-processes-code.js";
import { registerSearchCode } from "./ti-development/search-code.js";
import { registerImportProFile } from "./ti-development/import-pro-file.js";
import { registerExportProcessToPro } from "./ti-development/export-process-to-pro.js";
import { registerDiffProcessWithFile } from "./ti-development/diff-process-with-file.js";
import { registerDiffProcesses } from "./ti-development/diff-processes.js";
import { registerValidateProcessRefs } from "./ti-development/validate-process-refs.js";
import { registerUpsertProcess } from "./ti-development/upsert-process.js";
import { registerInstallProBundle } from "./ti-development/install-pro-bundle.js";
import { registerExportProcessToGit } from "./ti-development/export-process-to-git.js";
import { registerImportProcessFromGit } from "./ti-development/import-process-from-git.js";
import { registerCheckWritableCoords } from "./celldata/check-writable-coords.js";

// Dimension management tools
import { registerCreateElement } from "./dimension-management/create-element.js";
import { registerUpdateElement } from "./dimension-management/update-element.js";
import { registerDeleteElement } from "./dimension-management/delete-element.js";
import { registerMoveElement } from "./dimension-management/move-element.js";
import { registerCreateDimension } from "./dimension-management/create-dimension.js";
import { registerDeleteDimension } from "./dimension-management/delete-dimension.js";
import { registerBulkUpsertElements } from "./dimension-management/bulk-upsert-elements.js";
import { registerListElementAttributes } from "./dimension-management/list-element-attributes.js";
import { registerCreateElementAttribute } from "./dimension-management/create-element-attribute.js";
import { registerGetElementAttributeValues } from "./dimension-management/get-element-attribute-values.js";
import { registerUpdateElementAttributeValue } from "./dimension-management/update-element-attribute-value.js";
import { registerCreateHierarchy } from "./dimension-management/create-hierarchy.js";
import { registerDeleteHierarchy } from "./dimension-management/delete-hierarchy.js";

// Subset tools
import { registerListSubsets } from "./subsets/list-subsets.js";
import { registerGetSubset } from "./subsets/get-subset.js";
import { registerCreateSubset } from "./subsets/create-subset.js";
import { registerUpdateSubset } from "./subsets/update-subset.js";
import { registerDeleteSubset } from "./subsets/delete-subset.js";

// Model building tools
import { registerCreateCube } from "./model-building/create-cube.js";
import { registerDeleteCube } from "./model-building/delete-cube.js";
import { registerGetCubeRules } from "./model-building/get-cube-rules.js";
import { registerSetCubeRules } from "./model-building/set-cube-rules.js";
import { registerClearCube } from "./model-building/clear-cube.js";
import { registerUnloadCube } from "./model-building/unload-cube.js";
import { registerGetAllCubeRules } from "./model-building/get-all-cube-rules.js";
import { registerCheckCubeRule } from "./model-building/check-cube-rule.js";
import { registerSearchRules } from "./model-building/search-rules.js";

// View tools
import { registerListViews } from "./views/list-views.js";
import { registerCreateMdxView } from "./views/create-mdx-view.js";
import { registerCreateNativeView } from "./views/create-native-view.js";
import { registerDeleteView } from "./views/delete-view.js";

// Scheduling tools
import { registerToggleChore } from "./scheduling/toggle-chore.js";
import { registerExecuteChore } from "./scheduling/execute-chore.js";
import { registerCreateChore } from "./scheduling/create-chore.js";
import { registerUpdateChore } from "./scheduling/update-chore.js";
import { registerDeleteChore } from "./scheduling/delete-chore.js";

// Operations tools
import { registerGetMessageLog } from "./operations/get-message-log.js";
import { registerGetThreads } from "./operations/get-threads.js";
import { registerGetJobs } from "./operations/get-jobs.js";
import { registerGetServerInfo } from "./operations/get-server-info.js";
import { registerGetServerState } from "./operations/get-server-state.js";
import { registerGetTransactionLog } from "./operations/get-transaction-log.js";
import { registerGetAuditLog } from "./operations/get-audit-log.js";
import { registerGetSessions } from "./operations/get-sessions.js";
import { registerListErrorLogs } from "./operations/list-error-logs.js";
import { registerGetErrorLogContent } from "./operations/get-error-log-content.js";
import { registerDiagnoseProcessError } from "./operations/diagnose-process-error.js";
import { registerGetCubeStats } from "./operations/get-cube-stats.js";
import { registerSaveData } from "./operations/save-data.js";

// File operations tools
import { registerListFiles } from "./fileops/list-files.js";
import { registerGetFileContent } from "./fileops/get-file-content.js";
import { registerUploadFile } from "./fileops/upload-file.js";
import { registerDeleteFile } from "./fileops/delete-file.js";
import { registerSearchFiles } from "./fileops/search-files.js";

// Analysis tools
import { registerAnalyzeCallgraph } from "./analysis/analyze-callgraph.js";
import { registerAnalyzeObjectUsage } from "./analysis/analyze-object-usage.js";
import { registerTraceDataFlow } from "./analysis/trace-data-flow.js";
import { registerAnalyzeChoreGraph } from "./analysis/analyze-chore-graph.js";
import { registerInvalidateCallgraphCache } from "./analysis/invalidate-callgraph-cache.js";
import { registerFindOrphanDimensions } from "./analysis/find-orphan-dimensions.js";
import { registerCheckV12Readiness } from "./analysis/check-v12-readiness.js";
import { registerAuditNaming } from "./analysis/audit-naming.js";
import { registerAuditComplexity } from "./analysis/audit-complexity.js";
import { registerAuditFeeders } from "./analysis/audit-feeders.js";

// Security tools
import { registerListClients } from "./security/list-clients.js";
import { registerGetClient } from "./security/get-client.js";
import { registerCreateClient } from "./security/create-client.js";
import { registerUpdateClient } from "./security/update-client.js";
import { registerDeleteClient } from "./security/delete-client.js";
import { registerListGroups } from "./security/list-groups.js";
import { registerAssignClientGroup } from "./security/assign-client-group.js";
import { registerRemoveClientGroup } from "./security/remove-client-group.js";

// Single registry of every tool registrar, grouped by category. Adding a tool
// = add its import above and one entry here (adjacent edit, one PR hunk). The
// previous design kept a second hand-ordered call block that drifted from the
// import order; this array is the only call site. check-tool-registration.mjs
// fails the build if a `register*` export under src/tools/ is missing here.
type ToolRegistrar = (server: McpServer, tm1Client: TM1Client) => void;

const REGISTRARS: ToolRegistrar[] = [
  // Metadata
  registerListCubes,
  registerListDimensions,
  registerGetHierarchy,
  registerGetDescendants,
  registerGetAncestors,
  registerResolveDefaultMembers,
  registerListProcesses,
  registerListProcessesGrouped,
  registerListChores,

  // Cell data
  registerGetCellValue,
  registerExecuteMdx,
  registerGetView,
  registerGetViewDefinition,
  registerSampleCells,
  registerWriteCells,
  registerCheckFeeders,
  registerTraceFeeders,
  registerTraceCellCalculation,
  registerCheckWritableCoords,

  // TI development — writes go through registerUpsertProcess (bundled),
  // reads remain atomic for inspection without pulling full process code.
  registerExecuteProcess,
  registerGetProcessParameters,
  registerGetProcessCode,
  registerGetProcess,
  registerGetProcessDatasource,
  registerGetProcessVariables,
  registerDeleteProcess,
  registerCopyProcess,
  registerCompileProcess,
  registerCheckProcessCode,
  registerGetAllProcessesCode,
  registerSearchCode,
  registerImportProFile,
  registerExportProcessToPro,
  registerDiffProcessWithFile,
  registerDiffProcesses,
  registerValidateProcessRefs,
  registerUpsertProcess,
  registerInstallProBundle,
  registerExportProcessToGit,
  registerImportProcessFromGit,

  // Dimension management
  registerCreateDimension,
  registerDeleteDimension,
  registerBulkUpsertElements,
  registerCreateElement,
  registerUpdateElement,
  registerDeleteElement,
  registerMoveElement,
  registerListElementAttributes,
  registerCreateElementAttribute,
  registerGetElementAttributeValues,
  registerUpdateElementAttributeValue,
  registerCreateHierarchy,
  registerDeleteHierarchy,

  // Subsets
  registerListSubsets,
  registerGetSubset,
  registerCreateSubset,
  registerUpdateSubset,
  registerDeleteSubset,

  // Model building
  registerCreateCube,
  registerDeleteCube,
  registerGetCubeRules,
  registerSetCubeRules,
  registerClearCube,
  registerUnloadCube,
  registerGetAllCubeRules,
  registerCheckCubeRule,
  registerSearchRules,

  // Views
  registerListViews,
  registerCreateMdxView,
  registerCreateNativeView,
  registerDeleteView,

  // Scheduling
  registerToggleChore,
  registerExecuteChore,
  registerCreateChore,
  registerUpdateChore,
  registerDeleteChore,

  // Operations
  registerGetMessageLog,
  registerGetThreads,
  registerGetJobs,
  registerGetServerInfo,
  registerGetServerState,
  registerGetTransactionLog,
  registerGetAuditLog,
  registerGetSessions,
  registerListErrorLogs,
  registerGetErrorLogContent,
  registerDiagnoseProcessError,
  registerGetCubeStats,
  registerSaveData,

  // File operations
  registerListFiles,
  registerGetFileContent,
  registerUploadFile,
  registerDeleteFile,
  registerSearchFiles,

  // Analysis
  registerAnalyzeCallgraph,
  registerAnalyzeObjectUsage,
  registerTraceDataFlow,
  registerAnalyzeChoreGraph,
  registerInvalidateCallgraphCache,
  registerFindOrphanDimensions,
  registerCheckV12Readiness,
  registerAuditNaming,
  registerAuditComplexity,
  registerAuditFeeders,

  // Security
  registerListClients,
  registerGetClient,
  registerCreateClient,
  registerUpdateClient,
  registerDeleteClient,
  registerListGroups,
  registerAssignClientGroup,
  registerRemoveClientGroup,
];

export function registerAllTools(server: McpServer, tm1Client: TM1Client): void {
  for (const register of REGISTRARS) register(server, tm1Client);
}
