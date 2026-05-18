import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../tm1-client.js";

// Knowledge base
import { registerGetKnowledge } from "./knowledge/get-knowledge.js";

// Metadata tools
import { registerListCubes } from "./metadata/list-cubes.js";
import { registerListDimensions } from "./metadata/list-dimensions.js";
import { registerGetHierarchy } from "./metadata/get-hierarchy.js";
import { registerGetDescendants } from "./metadata/get-descendants.js";
import { registerGetAncestors } from "./metadata/get-ancestors.js";
import { registerResolveDefaultMember } from "./metadata/resolve-default-member.js";
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

// TI development tools (process CRUD, execution, code, params, datasource)
import { registerExecuteProcess } from "./ti-development/execute-process.js";
import { registerGetProcessParameters } from "./ti-development/get-process-parameters.js";
import { registerCreateProcess } from "./ti-development/create-process.js";
import { registerGetProcessCode } from "./ti-development/get-process-code.js";
import { registerUpdateProcessCode } from "./ti-development/update-process-code.js";
import { registerGetProcessDatasource } from "./ti-development/get-process-datasource.js";
import { registerUpdateProcessDatasource } from "./ti-development/update-process-datasource.js";
import { registerUpdateProcessParameters } from "./ti-development/update-process-parameters.js";
import { registerGetProcessVariables } from "./ti-development/get-process-variables.js";
import { registerUpdateProcessVariables } from "./ti-development/update-process-variables.js";
import { registerDeleteProcess } from "./ti-development/delete-process.js";
import { registerCopyProcess } from "./ti-development/copy-process.js";
import { registerCompileProcess } from "./ti-development/compile-process.js";
import { registerCheckProcessCode } from "./ti-development/check-process-code.js";
import { registerGetAllProcessesCode } from "./ti-development/get-all-processes-code.js";
import { registerSearchCode } from "./ti-development/search-code.js";
import { registerImportProFile } from "./ti-development/import-pro-file.js";
import { registerExportProcessToPro } from "./ti-development/export-process-to-pro.js";
import { registerDiffProcessWithFile } from "./ti-development/diff-process-with-file.js";
import { registerValidateProcessRefs } from "./ti-development/validate-process-refs.js";
import { registerUpsertProcess } from "./ti-development/upsert-process.js";
import { registerInstallProBundle } from "./ti-development/install-pro-bundle.js";
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

// View tools
import { registerListViews } from "./views/list-views.js";
import { registerCreateMdxView } from "./views/create-mdx-view.js";
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
import { registerGetServerInfo } from "./operations/get-server-info.js";
import { registerGetServerCapabilities } from "./operations/get-server-capabilities.js";
import { registerGetServerState } from "./operations/get-server-state.js";
import { registerGetTransactionLog } from "./operations/get-transaction-log.js";
import { registerGetSessions } from "./operations/get-sessions.js";
import { registerListErrorLogs } from "./operations/list-error-logs.js";
import { registerGetErrorLogContent } from "./operations/get-error-log-content.js";
import { registerDiagnoseProcessError } from "./operations/diagnose-process-error.js";
import { registerGetCubeStats } from "./operations/get-cube-stats.js";

// File operations tools
import { registerListFiles } from "./fileops/list-files.js";
import { registerGetFileContent } from "./fileops/get-file-content.js";
import { registerUploadFile } from "./fileops/upload-file.js";
import { registerDeleteFile } from "./fileops/delete-file.js";
import { registerSearchFiles } from "./fileops/search-files.js";

// Analysis tools
import { registerAnalyzeCallgraph } from "./analysis/analyze-callgraph.js";
import { registerAnalyzeObjectUsage } from "./analysis/analyze-object-usage.js";
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

export function registerAllTools(server: McpServer, tm1Client: TM1Client): void {
  // Metadata
  registerListCubes(server, tm1Client);
  registerListDimensions(server, tm1Client);
  registerGetHierarchy(server, tm1Client);
  registerGetDescendants(server, tm1Client);
  registerGetAncestors(server, tm1Client);
  registerResolveDefaultMember(server, tm1Client);
  registerResolveDefaultMembers(server, tm1Client);
  registerListProcesses(server, tm1Client);
  registerListProcessesGrouped(server, tm1Client);
  registerListChores(server, tm1Client);

  // Cell data
  registerGetCellValue(server, tm1Client);
  registerExecuteMdx(server, tm1Client);
  registerGetView(server, tm1Client);
  registerGetViewDefinition(server, tm1Client);
  registerSampleCells(server, tm1Client);
  registerWriteCells(server, tm1Client);

  // Process execution
  registerExecuteProcess(server, tm1Client);
  registerGetProcessParameters(server, tm1Client);

  // TI development
  registerCreateProcess(server, tm1Client);
  registerGetProcessCode(server, tm1Client);
  registerUpdateProcessCode(server, tm1Client);
  registerGetProcessDatasource(server, tm1Client);
  registerUpdateProcessDatasource(server, tm1Client);
  registerUpdateProcessParameters(server, tm1Client);
  registerGetProcessVariables(server, tm1Client);
  registerUpdateProcessVariables(server, tm1Client);
  registerDeleteProcess(server, tm1Client);
  registerCopyProcess(server, tm1Client);
  registerCompileProcess(server, tm1Client);
  registerCheckProcessCode(server, tm1Client);
  registerGetAllProcessesCode(server, tm1Client);
  registerSearchCode(server, tm1Client);
  registerImportProFile(server, tm1Client);
  registerExportProcessToPro(server, tm1Client);
  registerDiffProcessWithFile(server, tm1Client);
  registerValidateProcessRefs(server, tm1Client);
  registerUpsertProcess(server, tm1Client);
  registerInstallProBundle(server, tm1Client);
  registerCheckWritableCoords(server, tm1Client);

  // Dimension management
  registerCreateDimension(server, tm1Client);
  registerDeleteDimension(server, tm1Client);
  registerBulkUpsertElements(server, tm1Client);
  registerCreateElement(server, tm1Client);
  registerUpdateElement(server, tm1Client);
  registerDeleteElement(server, tm1Client);
  registerMoveElement(server, tm1Client);
  registerListElementAttributes(server, tm1Client);
  registerCreateElementAttribute(server, tm1Client);
  registerGetElementAttributeValues(server, tm1Client);
  registerUpdateElementAttributeValue(server, tm1Client);
  registerCreateHierarchy(server, tm1Client);
  registerDeleteHierarchy(server, tm1Client);

  // Subsets
  registerListSubsets(server, tm1Client);
  registerGetSubset(server, tm1Client);
  registerCreateSubset(server, tm1Client);
  registerUpdateSubset(server, tm1Client);
  registerDeleteSubset(server, tm1Client);

  // Model building
  registerCreateCube(server, tm1Client);
  registerDeleteCube(server, tm1Client);
  registerGetCubeRules(server, tm1Client);
  registerSetCubeRules(server, tm1Client);
  registerClearCube(server, tm1Client);
  registerUnloadCube(server, tm1Client);
  registerGetAllCubeRules(server, tm1Client);
  registerCheckCubeRule(server, tm1Client);

  // Views
  registerListViews(server, tm1Client);
  registerCreateMdxView(server, tm1Client);
  registerDeleteView(server, tm1Client);

  // Scheduling
  registerToggleChore(server, tm1Client);
  registerExecuteChore(server, tm1Client);
  registerCreateChore(server, tm1Client);
  registerUpdateChore(server, tm1Client);
  registerDeleteChore(server, tm1Client);

  // Operations
  registerGetMessageLog(server, tm1Client);
  registerGetThreads(server, tm1Client);
  registerGetServerInfo(server, tm1Client);
  registerGetServerCapabilities(server, tm1Client);
  registerGetServerState(server, tm1Client);
  registerGetTransactionLog(server, tm1Client);
  registerGetSessions(server, tm1Client);
  registerListErrorLogs(server, tm1Client);
  registerGetErrorLogContent(server, tm1Client);
  registerDiagnoseProcessError(server, tm1Client);
  registerGetCubeStats(server, tm1Client);

  // File operations
  registerListFiles(server, tm1Client);
  registerGetFileContent(server, tm1Client);
  registerUploadFile(server, tm1Client);
  registerDeleteFile(server, tm1Client);
  registerSearchFiles(server, tm1Client);

  // Analysis
  registerAnalyzeCallgraph(server, tm1Client);
  registerAnalyzeObjectUsage(server, tm1Client);
  registerAnalyzeChoreGraph(server, tm1Client);
  registerInvalidateCallgraphCache(server, tm1Client);
  registerFindOrphanDimensions(server, tm1Client);
  registerCheckV12Readiness(server, tm1Client);
  registerAuditNaming(server, tm1Client);
  registerAuditComplexity(server, tm1Client);
  registerAuditFeeders(server, tm1Client);

  // Security
  registerListClients(server, tm1Client);
  registerGetClient(server, tm1Client);
  registerCreateClient(server, tm1Client);
  registerUpdateClient(server, tm1Client);
  registerDeleteClient(server, tm1Client);
  registerListGroups(server, tm1Client);
  registerAssignClientGroup(server, tm1Client);
  registerRemoveClientGroup(server, tm1Client);

  // Knowledge base
  registerGetKnowledge(server);
}
