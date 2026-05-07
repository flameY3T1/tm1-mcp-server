// Maps tool name → outputSchema (raw shape OR full Zod schema). The McpServer
// Proxy in index.ts injects these into `server.registerTool` and wraps callbacks
// so the JSON-stringified text payload is also surfaced as `structuredContent`.
//
// Use a full ZodTypeAny entry (not `.shape`) when the schema relies on
// `.passthrough()` / `.catchall()` semantics — extracting `.shape` discards
// those flags, causing the SDK to publish JSON Schema with
// `additionalProperties: false` and reject legitimate per-tool extras.
//
// Phase 1: 12 paginated list_* tools. Adding more tools is a one-line
// addition here plus an item schema in ./schemas/items.ts.
import type { ZodRawShape, ZodTypeAny } from "zod";
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
  CubeStatsResultSchema,
  DataSourceSchema,
  DescendantsResultSchema,
  DiagnoseProcessErrorResultSchema,
  DiffProcessResultSchema,
  DimensionItemSchema,
  ElementAttributeValueSchema,
  ErrorLogContentResultSchema,
  ErrorLogFileSchema,
  ExportProcessToProResultSchema,
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
  AncestorsResultSchema,
  ProcessCodeSchema,
  ProcessItemSchema,
  ProcessParameterSchema,
  ProcessResultSchema,
  ProcessVariableSchema,
  ProcessesGroupedResultSchema,
  SearchCodeResultSchema,
  ServerCapabilitiesResultSchema,
  ServerInfoSchema,
  ServerStateResultSchema,
  SessionItemSchema,
  SubsetItemSchema,
  ThreadItemSchema,
  TransactionLogEntrySchema,
  UpsertProcessResultSchema,
  ValidateProcessRefsResultSchema,
  SampleCellsResultSchema,
  ViewDefinitionResultSchema,
  ViewItemSchema,
  ViewResultSchema,
  WritableCoordsResultSchema,
} from "./schemas/items.js";

// tm1_list_files prefixes a `path` field on top of the page envelope.
const filePageShape = {
  path: z.string().describe("Path that was listed (echoes the input)"),
  ...pageShapeFor(FilenameItemSchema),
};

export const OUTPUT_SCHEMA_MAP: Record<string, ZodRawShape | ZodTypeAny> = {
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
  // WritableCoordsResultSchema uses .passthrough() — pass full schema, not .shape.
  tm1_check_writable_coords: WritableCoordsResultSchema,
  tm1_validate_process_refs: ValidateProcessRefsResultSchema.shape,

  // ── Phase 2b: get_* single entity (JSON-returning subset) ─────────────────
  tm1_get_subset: SubsetItemSchema.shape,
  tm1_get_view: ViewResultSchema.shape,
  tm1_get_view_definition: ViewDefinitionResultSchema.shape,
  tm1_sample_cells: SampleCellsResultSchema.shape,
  tm1_get_hierarchy: HierarchySchema.shape,
  tm1_get_process_code: ProcessCodeSchema.shape,
  // DataSourceSchema uses .passthrough() — TM1 returns version-dependent extras.
  tm1_get_process_datasource: DataSourceSchema,
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
  // Schemas marked with .passthrough() are passed as full schemas to preserve
  // additionalProperties:true in the published JSON Schema (extras like
  // callgraphEntriesCleared, dataSource, etc. flow through unrejected).
  tm1_diff_process_with_file: DiffProcessResultSchema,
  tm1_upsert_process: UpsertProcessResultSchema,
  tm1_install_pro_bundle: InstallProBundleResultSchema,
  tm1_import_pro_file: ImportProFileResultSchema.shape,
  tm1_copy_process: CopyProcessResultSchema.shape,

  // ── Phase 2e: analysis tools ──────────────────────────────────────────────
  // CallgraphResultSchema uses .passthrough() — pass full schema.
  tm1_analyze_callgraph: CallgraphResultSchema,
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
  // ClientItemSchema and ServerInfoSchema use .passthrough() — pass full schema.
  tm1_get_client: ClientItemSchema,
  tm1_get_cube_rules: CubeRulesSchema.shape,
  tm1_get_cube_stats: CubeStatsResultSchema,
  tm1_get_server_info: ServerInfoSchema,
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
  // IMPORTANT: pass the full schema (not `.shape`) — extracting `.shape`
  // discards the .passthrough() flag, which would cause the published JSON
  // Schema to set `additionalProperties: false` and reject the per-tool extras.
  tm1_assign_client_group: MutationResultSchema,
  tm1_cancel_thread: MutationResultSchema,
  tm1_clear_cube: MutationResultSchema,
  tm1_create_chore: MutationResultSchema,
  tm1_create_client: MutationResultSchema,
  tm1_create_element: MutationResultSchema,
  tm1_create_element_attribute: MutationResultSchema,
  tm1_create_process: MutationResultSchema,
  tm1_create_subset: MutationResultSchema,
  tm1_delete_element: MutationResultSchema,
  tm1_delete_process: MutationResultSchema,
  tm1_delete_subset: MutationResultSchema,
  tm1_move_element: MutationResultSchema,
  tm1_update_element: MutationResultSchema,
  tm1_update_element_attribute_value: MutationResultSchema,
  tm1_update_process_code: MutationResultSchema,
  tm1_update_process_datasource: MutationResultSchema,
  tm1_update_process_parameters: MutationResultSchema,
  tm1_update_process_variables: MutationResultSchema,
  tm1_update_subset: MutationResultSchema,
  tm1_write_cells: MutationResultSchema,

  // Bespoke shape: cleared/entriesBefore counters, no `success` field.
  tm1_invalidate_callgraph_cache: InvalidateCallgraphCacheResultSchema.shape,

  // ── Phase 2i: hierarchy navigation, server snapshots, diagnostics ────────
  tm1_get_ancestors: AncestorsResultSchema.shape,
  tm1_get_descendants: DescendantsResultSchema.shape,
  tm1_get_server_capabilities: ServerCapabilitiesResultSchema,
  tm1_get_server_state: ServerStateResultSchema,
  tm1_list_processes_grouped: ProcessesGroupedResultSchema.shape,
  tm1_diagnose_process_error: DiagnoseProcessErrorResultSchema.shape,
  tm1_export_process_to_pro: ExportProcessToProResultSchema.shape,

  // ── Phase 2j: text→JSON-converted mutations ──────────────────────────────
  tm1_bulk_upsert_elements: MutationResultSchema,
  tm1_create_cube: MutationResultSchema,
  tm1_create_dimension: MutationResultSchema,
  tm1_create_hierarchy: MutationResultSchema,
  tm1_create_mdx_view: MutationResultSchema,
  tm1_delete_chore: MutationResultSchema,
  tm1_delete_client: MutationResultSchema,
  tm1_delete_cube: MutationResultSchema,
  tm1_delete_dimension: MutationResultSchema,
  tm1_delete_hierarchy: MutationResultSchema,
  tm1_delete_view: MutationResultSchema,
  tm1_execute_chore: MutationResultSchema,
  tm1_remove_client_group: MutationResultSchema,
  tm1_set_cube_rules: MutationResultSchema,
  tm1_toggle_chore: MutationResultSchema,
  tm1_unload_cube: MutationResultSchema,
  tm1_update_chore: MutationResultSchema,
  tm1_update_client: MutationResultSchema,
};
