// Tool name -> annotation hint mapping. Centralized so register* functions
// don't need per-file edits. Used by makeAnnotatedServer() in src/index.ts,
// which wraps McpServer.tool to inject the matching annotation as the
// SDK's 5-arg overload (name, desc, schema, annotations, cb).
//
// Categorization rules:
//   READ_ONLY         GET / list / search / analyze / validate / compile / diff
//   IDEMPOTENT_WRITE  PUT-style updates: same input -> same end state
//   WRITE             POST-style creates / non-idempotent (toggle, write_cells)
//   DESTRUCTIVE       delete / clear / unload / cancel / remove / invalidate /
//                     execute (TI side effects)
import {
  READ_ONLY,
  IDEMPOTENT_WRITE,
  WRITE,
  DESTRUCTIVE,
  withVersion,
  type Tm1ToolAnnotations,
} from "./annotations.js";

export const ANNOTATION_MAP: Record<string, Tm1ToolAnnotations> = {
  // analysis
  tm1_analyze_callgraph: READ_ONLY,
  tm1_analyze_chore_graph: READ_ONLY,
  tm1_analyze_object_usage: READ_ONLY,
  tm1_audit_complexity: READ_ONLY,
  tm1_audit_feeders: READ_ONLY,
  tm1_audit_naming: READ_ONLY,
  // v11-only: static gap-analysis specifically targeting v11 → v12 migration.
  // Running on a v12 instance is a no-op (everything is already deprecated).
  tm1_check_v12_readiness: withVersion(READ_ONLY, "v11"),
  tm1_find_orphan_dimensions: READ_ONLY,
  tm1_invalidate_callgraph_cache: IDEMPOTENT_WRITE,

  // celldata
  tm1_check_writable_coords: READ_ONLY,
  // v11-only cell diagnostics: CheckFeeders/TraceFeeders/TraceCellCalculation
  // actions are not exposed by the v12 REST API.
  tm1_check_feeders: withVersion(READ_ONLY, "v11"),
  tm1_trace_feeders: withVersion(READ_ONLY, "v11"),
  tm1_trace_cell_calculation: withVersion(READ_ONLY, "v11"),
  tm1_execute_mdx: READ_ONLY,
  tm1_get_cell_value: READ_ONLY,
  tm1_get_view: READ_ONLY,
  tm1_get_view_definition: READ_ONLY,
  tm1_sample_cells: READ_ONLY,
  tm1_write_cells: WRITE,

  // dimension-management
  tm1_bulk_upsert_elements: IDEMPOTENT_WRITE,
  tm1_create_dimension: WRITE,
  tm1_create_element_attribute: WRITE,
  tm1_create_element: WRITE,
  tm1_create_hierarchy: WRITE,
  tm1_delete_dimension: DESTRUCTIVE,
  tm1_delete_element: DESTRUCTIVE,
  tm1_delete_hierarchy: DESTRUCTIVE,
  tm1_get_element_attribute_values: READ_ONLY,
  tm1_list_element_attributes: READ_ONLY,
  tm1_move_element: WRITE,
  tm1_update_element_attribute_value: IDEMPOTENT_WRITE,
  tm1_update_element: IDEMPOTENT_WRITE,

  // fileops
  tm1_get_file_content: READ_ONLY,
  tm1_list_files: READ_ONLY,
  tm1_search_files: READ_ONLY,
  tm1_upload_file: IDEMPOTENT_WRITE,
  tm1_delete_file: DESTRUCTIVE,

  // metadata
  tm1_get_ancestors: READ_ONLY,
  tm1_get_descendants: READ_ONLY,
  tm1_get_hierarchy: READ_ONLY,
  tm1_list_chores: READ_ONLY,
  tm1_list_cubes: READ_ONLY,
  tm1_list_dimensions: READ_ONLY,
  tm1_list_processes: READ_ONLY,
  tm1_list_processes_grouped: READ_ONLY,
  tm1_resolve_default_member: READ_ONLY,
  tm1_resolve_default_members: READ_ONLY,

  // model-building
  tm1_check_cube_rule: READ_ONLY,
  tm1_clear_cube: DESTRUCTIVE,
  tm1_create_cube: WRITE,
  tm1_delete_cube: DESTRUCTIVE,
  tm1_get_all_cube_rules: READ_ONLY,
  tm1_get_cube_rules: READ_ONLY,
  tm1_get_cube_stats: READ_ONLY,
  tm1_search_rules: READ_ONLY,
  tm1_unload_cube: DESTRUCTIVE,
  tm1_set_cube_rules: IDEMPOTENT_WRITE,

  // operations
  tm1_diagnose_process_error: READ_ONLY,
  tm1_get_error_log_content: READ_ONLY,
  tm1_get_message_log: READ_ONLY,
  tm1_get_server_info: READ_ONLY,
  tm1_get_server_state: READ_ONLY,
  tm1_list_error_logs: READ_ONLY,
  tm1_list_sessions: READ_ONLY,
  tm1_list_threads: READ_ONLY,
  tm1_cancel_thread: DESTRUCTIVE,
  tm1_get_transaction_log: READ_ONLY,
  // v11-only: /AuditLogEntries (file-based audit log) is not exposed by the
  // v12 REST API.
  tm1_get_audit_log: withVersion(READ_ONLY, "v11"),
  // Idempotent: repeat runs converge on the same end state (disk == memory).
  // v11-only: SaveDataAll/CubeSaveData removed in v12 (auto-persistence).
  tm1_save_data: withVersion(IDEMPOTENT_WRITE, "v11"),

  // ti-development (process execution / params)
  tm1_execute_process: DESTRUCTIVE,
  tm1_get_process_parameters: READ_ONLY,

  // scheduling
  tm1_create_chore: WRITE,
  tm1_delete_chore: DESTRUCTIVE,
  tm1_execute_chore: DESTRUCTIVE,
  tm1_toggle_chore: IDEMPOTENT_WRITE,
  tm1_update_chore: IDEMPOTENT_WRITE,

  // security
  tm1_assign_client_group: IDEMPOTENT_WRITE,
  tm1_create_client: WRITE,
  tm1_delete_client: DESTRUCTIVE,
  tm1_get_client: READ_ONLY,
  tm1_list_clients: READ_ONLY,
  tm1_list_groups: READ_ONLY,
  tm1_remove_client_group: DESTRUCTIVE,
  tm1_update_client: IDEMPOTENT_WRITE,

  // subsets
  tm1_create_subset: WRITE,
  tm1_delete_subset: DESTRUCTIVE,
  tm1_get_subset: READ_ONLY,
  tm1_list_subsets: READ_ONLY,
  tm1_update_subset: IDEMPOTENT_WRITE,

  // ti-development
  tm1_check_process_code: READ_ONLY,
  tm1_compile_process: READ_ONLY,
  tm1_copy_process: WRITE,
  tm1_delete_process: DESTRUCTIVE,
  // .pro is the v11 Planning Analytics Architect file format. v12 (Cloud
  // Native) deploys via different tooling (TM1Web / git-of-records); .pro
  // round-trip is meaningful only against v11 instances.
  tm1_diff_process_with_file: withVersion(READ_ONLY, "v11"),
  tm1_diff_processes: READ_ONLY,
  tm1_export_process_to_pro: withVersion(READ_ONLY, "v11"),
  tm1_export_process_to_git: READ_ONLY,
  tm1_import_process_from_git: IDEMPOTENT_WRITE,
  tm1_get_all_processes_code: READ_ONLY,
  tm1_get_process_code: READ_ONLY,
  tm1_get_process_datasource: READ_ONLY,
  tm1_get_process_variables: READ_ONLY,
  tm1_import_pro_file: withVersion(IDEMPOTENT_WRITE, "v11"),
  tm1_install_pro_bundle: withVersion(IDEMPOTENT_WRITE, "v11"),
  tm1_search_code: READ_ONLY,
  tm1_upsert_process: IDEMPOTENT_WRITE,
  tm1_validate_process_refs: READ_ONLY,

  // views
  tm1_create_mdx_view: WRITE,
  tm1_create_native_view: WRITE,
  tm1_delete_view: DESTRUCTIVE,
  tm1_list_views: READ_ONLY,
};
