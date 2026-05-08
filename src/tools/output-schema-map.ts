// Maps tool name → outputSchema (raw shape OR full Zod schema). The McpServer
// Proxy in index.ts injects these into `server.registerTool` and wraps callbacks
// so the JSON-stringified text payload is also surfaced as `structuredContent`.
//
// Named-schema entries route through `asOutputSchema(Schema)` which auto-picks
// the correct representation (full ZodTypeAny for passthrough/catchall, raw
// shape otherwise). This avoids the manual footgun where `.shape` silently
// drops `additionalProperties: true` from passthrough schemas.
//
// Phase 1: 12 paginated list_* tools. Adding more tools is a one-line
// addition here plus an item schema in ./schemas/items.ts.
import type { ZodRawShape, ZodTypeAny } from "zod";
import { z } from "zod";
import { pageShapeFor } from "./schemas/common.js";
import { asOutputSchema } from "./schemas/output-schema.js";
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
  tm1_list_sessions: {
    ...pageShapeFor(SessionItemSchema),
    summary: z
      .object({
        namedUsers: z.number().int(),
        anonymousCount: z.number().int(),
      })
      .optional()
      .describe("Present only when compact=true: aggregate headcount, items[] is empty in that mode"),
  },
  tm1_list_element_attributes: pageShapeFor(ElementAttributeValueSchema),

  // ── Phase 2a: validation/check tools ──────────────────────────────────────
  tm1_check_writable_coords: asOutputSchema(WritableCoordsResultSchema),
  tm1_validate_process_refs: asOutputSchema(ValidateProcessRefsResultSchema),

  // ── Phase 2b: get_* single entity (JSON-returning subset) ─────────────────
  tm1_get_subset: asOutputSchema(SubsetItemSchema),
  tm1_get_view: asOutputSchema(ViewResultSchema),
  tm1_get_view_definition: asOutputSchema(ViewDefinitionResultSchema),
  tm1_sample_cells: asOutputSchema(SampleCellsResultSchema),
  tm1_get_hierarchy: asOutputSchema(HierarchySchema),
  tm1_get_process_code: asOutputSchema(ProcessCodeSchema),
  tm1_get_process_datasource: asOutputSchema(DataSourceSchema),
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
  tm1_execute_mdx: asOutputSchema(MdxResultSchema),
  tm1_execute_process: asOutputSchema(ProcessResultSchema),

  // ── Phase 2d: diff/bundle/upsert ──────────────────────────────────────────
  tm1_diff_process_with_file: asOutputSchema(DiffProcessResultSchema),
  tm1_upsert_process: asOutputSchema(UpsertProcessResultSchema),
  tm1_install_pro_bundle: asOutputSchema(InstallProBundleResultSchema),
  tm1_import_pro_file: asOutputSchema(ImportProFileResultSchema),
  tm1_copy_process: asOutputSchema(CopyProcessResultSchema),

  // ── Phase 2e: analysis tools ──────────────────────────────────────────────
  tm1_analyze_callgraph: asOutputSchema(CallgraphResultSchema),
  tm1_analyze_chore_graph: asOutputSchema(ChoreGraphResultSchema),
  tm1_analyze_object_usage: asOutputSchema(ObjectUsageResultSchema),
  tm1_search_code: asOutputSchema(SearchCodeResultSchema),

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
  tm1_get_client: asOutputSchema(ClientItemSchema),
  tm1_get_cube_rules: asOutputSchema(CubeRulesSchema),
  tm1_get_cube_stats: asOutputSchema(CubeStatsResultSchema),
  tm1_get_server_info: asOutputSchema(ServerInfoSchema),
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
  tm1_get_error_log_content: asOutputSchema(ErrorLogContentResultSchema),
  tm1_get_file_content: asOutputSchema(FileContentResultSchema),

  // ── Phase 2h: mutations (already-JSON + 5 refactored to JSON) ─────────────
  // Generic MutationResultSchema (success + passthrough) covers per-tool extras
  // like cellsWritten, parameterCount, updatedTabs without bespoke schemas.
  // asOutputSchema preserves the .passthrough() flag automatically.
  tm1_assign_client_group: asOutputSchema(MutationResultSchema),
  tm1_cancel_thread: asOutputSchema(MutationResultSchema),
  tm1_clear_cube: asOutputSchema(MutationResultSchema),
  tm1_create_chore: asOutputSchema(MutationResultSchema),
  tm1_create_client: asOutputSchema(MutationResultSchema),
  tm1_create_element: asOutputSchema(MutationResultSchema),
  tm1_create_element_attribute: asOutputSchema(MutationResultSchema),
  tm1_create_process: asOutputSchema(MutationResultSchema),
  tm1_create_subset: asOutputSchema(MutationResultSchema),
  tm1_delete_element: asOutputSchema(MutationResultSchema),
  tm1_delete_process: asOutputSchema(MutationResultSchema),
  tm1_delete_subset: asOutputSchema(MutationResultSchema),
  tm1_move_element: asOutputSchema(MutationResultSchema),
  tm1_update_element: asOutputSchema(MutationResultSchema),
  tm1_update_element_attribute_value: asOutputSchema(MutationResultSchema),
  tm1_update_process_code: asOutputSchema(MutationResultSchema),
  tm1_update_process_datasource: asOutputSchema(MutationResultSchema),
  tm1_update_process_parameters: asOutputSchema(MutationResultSchema),
  tm1_update_process_variables: asOutputSchema(MutationResultSchema),
  tm1_update_subset: asOutputSchema(MutationResultSchema),
  tm1_write_cells: asOutputSchema(MutationResultSchema),

  // Bespoke shape: cleared/entriesBefore counters, no `success` field.
  tm1_invalidate_callgraph_cache: asOutputSchema(InvalidateCallgraphCacheResultSchema),

  // ── Phase 2i: hierarchy navigation, server snapshots, diagnostics ────────
  tm1_get_ancestors: asOutputSchema(AncestorsResultSchema),
  tm1_get_descendants: asOutputSchema(DescendantsResultSchema),
  tm1_get_server_capabilities: asOutputSchema(ServerCapabilitiesResultSchema),
  tm1_get_server_state: asOutputSchema(ServerStateResultSchema),
  tm1_list_processes_grouped: asOutputSchema(ProcessesGroupedResultSchema),
  tm1_diagnose_process_error: asOutputSchema(DiagnoseProcessErrorResultSchema),
  tm1_export_process_to_pro: asOutputSchema(ExportProcessToProResultSchema),

  // ── Phase 2j: text→JSON-converted mutations ──────────────────────────────
  tm1_bulk_upsert_elements: asOutputSchema(MutationResultSchema),
  tm1_create_cube: asOutputSchema(MutationResultSchema),
  tm1_create_dimension: asOutputSchema(MutationResultSchema),
  tm1_create_hierarchy: asOutputSchema(MutationResultSchema),
  tm1_create_mdx_view: asOutputSchema(MutationResultSchema),
  tm1_delete_chore: asOutputSchema(MutationResultSchema),
  tm1_delete_client: asOutputSchema(MutationResultSchema),
  tm1_delete_cube: asOutputSchema(MutationResultSchema),
  tm1_delete_dimension: asOutputSchema(MutationResultSchema),
  tm1_delete_hierarchy: asOutputSchema(MutationResultSchema),
  tm1_delete_view: asOutputSchema(MutationResultSchema),
  tm1_execute_chore: asOutputSchema(MutationResultSchema),
  tm1_remove_client_group: asOutputSchema(MutationResultSchema),
  tm1_set_cube_rules: asOutputSchema(MutationResultSchema),
  tm1_toggle_chore: asOutputSchema(MutationResultSchema),
  tm1_unload_cube: asOutputSchema(MutationResultSchema),
  tm1_update_chore: asOutputSchema(MutationResultSchema),
  tm1_update_client: asOutputSchema(MutationResultSchema),
};
