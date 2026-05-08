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
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { READ_ONLY, IDEMPOTENT_WRITE, WRITE, DESTRUCTIVE } from "./annotations.js";

export const ANNOTATION_MAP: Record<string, ToolAnnotations> = {
  // analysis
  tm1_analyze_callgraph: READ_ONLY,
  tm1_analyze_chore_graph: READ_ONLY,
  tm1_analyze_object_usage: READ_ONLY,
  tm1_invalidate_callgraph_cache: DESTRUCTIVE,

  // celldata
  tm1_check_writable_coords: READ_ONLY,
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

  // metadata
  tm1_get_ancestors: READ_ONLY,
  tm1_get_descendants: READ_ONLY,
  tm1_get_hierarchy: READ_ONLY,
  tm1_list_chores: READ_ONLY,
  tm1_list_cubes: READ_ONLY,
  tm1_list_dimensions: READ_ONLY,
  tm1_list_processes: READ_ONLY,
  tm1_list_processes_grouped: READ_ONLY,

  // model-building
  tm1_check_cube_rule: READ_ONLY,
  tm1_clear_cube: DESTRUCTIVE,
  tm1_create_cube: WRITE,
  tm1_delete_cube: DESTRUCTIVE,
  tm1_get_all_cube_rules: READ_ONLY,
  tm1_get_cube_rules: READ_ONLY,
  tm1_get_cube_stats: READ_ONLY,
  tm1_unload_cube: DESTRUCTIVE,
  tm1_set_cube_rules: IDEMPOTENT_WRITE,
  tm1_get_knowledge: READ_ONLY,

  // operations
  tm1_diagnose_process_error: READ_ONLY,
  tm1_get_error_log_content: READ_ONLY,
  tm1_get_message_log: READ_ONLY,
  tm1_get_server_capabilities: READ_ONLY,
  tm1_get_server_info: READ_ONLY,
  tm1_get_server_state: READ_ONLY,
  tm1_list_error_logs: READ_ONLY,
  tm1_list_sessions: READ_ONLY,
  tm1_list_threads: READ_ONLY,
  tm1_cancel_thread: DESTRUCTIVE,
  tm1_get_transaction_log: READ_ONLY,

  // ti-development (process execution / params)
  tm1_execute_process: DESTRUCTIVE,
  tm1_get_process_parameters: READ_ONLY,

  // scheduling
  tm1_create_chore: WRITE,
  tm1_delete_chore: DESTRUCTIVE,
  tm1_execute_chore: DESTRUCTIVE,
  tm1_toggle_chore: WRITE,
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
  tm1_create_process: WRITE,
  tm1_delete_process: DESTRUCTIVE,
  tm1_diff_process_with_file: READ_ONLY,
  tm1_export_process_to_pro: READ_ONLY,
  tm1_get_all_processes_code: READ_ONLY,
  tm1_get_process_code: READ_ONLY,
  tm1_get_process_datasource: READ_ONLY,
  tm1_get_process_variables: READ_ONLY,
  tm1_import_pro_file: IDEMPOTENT_WRITE,
  tm1_install_pro_bundle: IDEMPOTENT_WRITE,
  tm1_search_code: READ_ONLY,
  tm1_update_process_code: IDEMPOTENT_WRITE,
  tm1_update_process_datasource: IDEMPOTENT_WRITE,
  tm1_update_process_parameters: IDEMPOTENT_WRITE,
  tm1_update_process_variables: IDEMPOTENT_WRITE,
  tm1_upsert_process: IDEMPOTENT_WRITE,
  tm1_validate_process_refs: READ_ONLY,

  // views
  tm1_create_mdx_view: WRITE,
  tm1_delete_view: DESTRUCTIVE,
  tm1_list_views: READ_ONLY,
};
