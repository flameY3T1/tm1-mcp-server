// Maps tool name → outputSchema raw shape. The McpServer Proxy in index.ts
// injects these into `server.registerTool` and wraps callbacks so the
// JSON-stringified text payload is also surfaced as `structuredContent`.
//
// Phase 1: 12 paginated list_* tools. Adding more tools is a one-line
// addition here plus an item schema in ./schemas/items.ts.
import type { ZodRawShape } from "zod";
import { z } from "zod";
import { pageShapeFor } from "./schemas/common.js";
import {
  CallgraphResultSchema,
  CellValueSchema,
  ChoreGraphResultSchema,
  ChoreItemSchema,
  ClientItemSchema,
  CompileErrorSchema,
  CopyProcessResultSchema,
  CubeItemSchema,
  CubeRulesSchema,
  DataSourceSchema,
  DiffProcessResultSchema,
  DimensionItemSchema,
  ElementAttributeValueSchema,
  ErrorLogContentResultSchema,
  ErrorLogFileSchema,
  FileContentResultSchema,
  FilenameItemSchema,
  GroupItemSchema,
  HierarchySchema,
  ImportProFileResultSchema,
  InstallProBundleResultSchema,
  InvalidateCallgraphCacheResultSchema,
  MdxResultSchema,
  MessageLogEntrySchema,
  MutationResultSchema,
  ObjectUsageResultSchema,
  ProcessCodeSchema,
  ProcessItemSchema,
  ProcessParameterSchema,
  ProcessResultSchema,
  ProcessVariableSchema,
  SearchCodeResultSchema,
  ServerInfoSchema,
  SessionItemSchema,
  SubsetItemSchema,
  ThreadItemSchema,
  TransactionLogEntrySchema,
  UpsertProcessResultSchema,
  ValidateProcessRefsResultSchema,
  ViewItemSchema,
  ViewResultSchema,
  WritableCoordsResultSchema,
} from "./schemas/items.js";

// tm1_list_files prefixes a `path` field on top of the page envelope.
const filePageShape = {
  path: z.string().describe("Path that was listed (echoes the input)"),
  ...pageShapeFor(FilenameItemSchema),
};

export const OUTPUT_SCHEMA_MAP: Record<string, ZodRawShape> = {
  tm1_list_cubes: pageShapeFor(CubeItemSchema),
  tm1_list_dimensions: pageShapeFor(DimensionItemSchema),
  tm1_list_processes: pageShapeFor(ProcessItemSchema),
  tm1_list_chores: pageShapeFor(ChoreItemSchema),
  tm1_list_clients: pageShapeFor(ClientItemSchema),
  tm1_list_groups: pageShapeFor(GroupItemSchema),
  tm1_list_views: pageShapeFor(ViewItemSchema),
  tm1_list_subsets: pageShapeFor(SubsetItemSchema),
  tm1_list_files: filePageShape,
  tm1_list_threads: pageShapeFor(ThreadItemSchema),
  tm1_list_sessions: pageShapeFor(SessionItemSchema),
  tm1_list_element_attributes: pageShapeFor(ElementAttributeValueSchema),

  // ── Phase 2a: validation/check tools ──────────────────────────────────────
  tm1_check_writable_coords: WritableCoordsResultSchema.shape,
  tm1_validate_process_refs: ValidateProcessRefsResultSchema.shape,

  // ── Phase 2b: get_* single entity (JSON-returning subset) ─────────────────
  tm1_get_subset: SubsetItemSchema.shape,
  tm1_get_view: ViewResultSchema.shape,
  tm1_get_hierarchy: HierarchySchema.shape,
  tm1_get_process_code: ProcessCodeSchema.shape,
  tm1_get_process_datasource: DataSourceSchema.shape,
  tm1_get_cell_value: { value: CellValueSchema.describe("Cell value (string, number, or null)") },
  tm1_get_all_cube_rules: {
    count: z.number().int().describe("Number of cubes returned"),
    cubes: z.array(CubeRulesSchema).describe("Per-cube rule bundles"),
  },
  tm1_get_all_processes_code: {
    count: z.number().int().describe("Number of processes returned"),
    processes: z.array(z.unknown()).describe("Per-process code bundles"),
  },
  tm1_get_element_attribute_values: {
    dimensionName: z.string(),
    elementName: z.string(),
    attributes: z.array(ElementAttributeValueSchema),
  },

  // ── Phase 2c: execute_* (JSON-returning subset) ───────────────────────────
  tm1_execute_mdx: MdxResultSchema.shape,
  tm1_execute_process: ProcessResultSchema.shape,

  // ── Phase 2d: diff/bundle/upsert ──────────────────────────────────────────
  tm1_diff_process_with_file: DiffProcessResultSchema.shape,
  tm1_upsert_process: UpsertProcessResultSchema.shape,
  tm1_install_pro_bundle: InstallProBundleResultSchema.shape,
  tm1_import_pro_file: ImportProFileResultSchema.shape,
  tm1_copy_process: CopyProcessResultSchema.shape,

  // ── Phase 2e: analysis tools ──────────────────────────────────────────────
  tm1_analyze_callgraph: CallgraphResultSchema.shape,
  tm1_analyze_chore_graph: ChoreGraphResultSchema.shape,
  tm1_analyze_object_usage: ObjectUsageResultSchema.shape,
  tm1_search_code: SearchCodeResultSchema.shape,

  // ── Phase 2f: validators (refactored from prose) and array-root wraps ─────
  tm1_check_cube_rule: {
    ok: z.boolean(),
    cube: z.string(),
    lineCount: z.number().int(),
    errorCount: z.number().int(),
    errors: z.array(
      z.object({
        lineNumber: z.number().int().optional(),
        message: z.string(),
      }),
    ),
  },
  tm1_check_process_code: {
    ok: z.boolean(),
    processName: z.string(),
    errorCount: z.number().int(),
    errors: z.array(CompileErrorSchema),
  },
  tm1_compile_process: {
    ok: z.boolean(),
    processName: z.string(),
    errorCount: z.number().int(),
    errors: z.array(CompileErrorSchema),
  },
  tm1_get_process_parameters: {
    processName: z.string(),
    parameters: z.array(ProcessParameterSchema),
  },
  tm1_get_process_variables: {
    processName: z.string(),
    variables: z.array(ProcessVariableSchema),
  },

  // ── Phase 2g: refactored plain-text get_* (now JSON) ──────────────────────
  tm1_get_client: ClientItemSchema.shape,
  tm1_get_cube_rules: CubeRulesSchema.shape,
  tm1_get_server_info: ServerInfoSchema.shape,
  tm1_get_message_log: {
    count: z.number().int(),
    entries: z.array(MessageLogEntrySchema),
  },
  tm1_get_transaction_log: {
    count: z.number().int(),
    entries: z.array(TransactionLogEntrySchema),
  },
  tm1_list_error_logs: {
    count: z.number().int(),
    files: z.array(ErrorLogFileSchema),
  },
  tm1_get_error_log_content: ErrorLogContentResultSchema.shape,
  tm1_get_file_content: FileContentResultSchema.shape,

  // ── Phase 2h: mutations (already-JSON + 5 refactored to JSON) ─────────────
  // Generic MutationResultSchema (success + passthrough) covers per-tool extras
  // like cellsWritten, parameterCount, updatedTabs without bespoke schemas.
  tm1_assign_client_group: MutationResultSchema.shape,
  tm1_cancel_thread: MutationResultSchema.shape,
  tm1_clear_cube: MutationResultSchema.shape,
  tm1_create_chore: MutationResultSchema.shape,
  tm1_create_client: MutationResultSchema.shape,
  tm1_create_element: MutationResultSchema.shape,
  tm1_create_element_attribute: MutationResultSchema.shape,
  tm1_create_process: MutationResultSchema.shape,
  tm1_create_subset: MutationResultSchema.shape,
  tm1_delete_element: MutationResultSchema.shape,
  tm1_delete_process: MutationResultSchema.shape,
  tm1_delete_subset: MutationResultSchema.shape,
  tm1_move_element: MutationResultSchema.shape,
  tm1_update_element: MutationResultSchema.shape,
  tm1_update_element_attribute_value: MutationResultSchema.shape,
  tm1_update_process_code: MutationResultSchema.shape,
  tm1_update_process_datasource: MutationResultSchema.shape,
  tm1_update_process_parameters: MutationResultSchema.shape,
  tm1_update_process_variables: MutationResultSchema.shape,
  tm1_update_subset: MutationResultSchema.shape,
  tm1_write_cells: MutationResultSchema.shape,

  // Bespoke shape: cleared/entriesBefore counters, no `success` field.
  tm1_invalidate_callgraph_cache: InvalidateCallgraphCacheResultSchema.shape,
};
