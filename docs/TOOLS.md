<!-- The list between the TOOLS-AUTOGEN sentinels below is GENERATED from the
     source by scripts/gen-tool-list.mjs. Regenerate with
     `npm run tools:update-readme`; any hand edit inside the sentinels is
     overwritten without warning. Text outside them is hand-written and kept. -->

# Tool reference

Every tool this server can register, with the first sentence of the description
the model sees. Working JSON payloads for the main flows are in
[EXAMPLES.md](EXAMPLES.md).

Two things the raw list does not show:

- **No single server exposes all of them.** `TM1_MODE=readonly` (the default)
  registers read tools only. Version also gates a few: `tm1_list_threads`,
  `tm1_cancel_thread` and `tm1_save_data` are v11-only, `tm1_list_jobs` and
  `tm1_cancel_job` are v12-only.
- **Seventeen tools require a `confirm` argument** that repeats the target name
  verbatim — every `delete_*` and `clear_*`, plus `tm1_execute_process`,
  `tm1_execute_chore`, `tm1_write_cells`, `tm1_set_cube_rules` and
  `tm1_upload_file`. It is misuse protection against a mis-fired call, not
  access control.

## Categories

| Category               | What it covers                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`             | list cubes / dimensions / processes / chores, hierarchy read, ancestors and descendants, default-member resolution                                                                                |
| `model-building`       | create/delete/clear/unload cube, get/set/check cube rules, bulk read of all rules, regex search across rules                                                                                      |
| `dimension-management` | dimension + hierarchy CRUD, element CRUD, bulk element upsert, element-attribute definitions and values                                                                                           |
| `subsets`              | list / get / create / update / delete subsets                                                                                                                                                     |
| `views`                | list views, create MDX or native (subset-based) view, delete view                                                                                                                                 |
| `celldata`             | execute MDX (with `format=markdown` pivot render), read a view, get a cell, write cells, sample cells, pre-write coordinate check (N-level + rule-overlap warning), feeder check and feeder trace |
| `ti-development`       | process CRUD and upsert, compile, unbound pre-save check, get/update code (single + bulk), datasource, variables, parameters, regex search across all TI, reference validation, process diff      |
| `scheduling`           | chore CRUD, execute now, activate/deactivate                                                                                                                                                      |
| `security`             | client and group CRUD, group assignment                                                                                                                                                           |
| `operations`           | server info and state, message / transaction / audit logs, error logs, threads (v11) or jobs (v12), sessions, save data (v11), cube stats                                                         |
| `fileops`              | list, search, read, upload and delete server-side files                                                                                                                                           |
| `analysis`             | process callgraph (tree, summary mode, global fan-in/fan-out ranking), object usage, chore graph, data-flow trace, naming / complexity / feeder audits, v12-readiness scan, orphan dimensions     |

The `.pro` and git round-trip tools (`tm1_import_pro_file`,
`tm1_export_process_to_pro`, `tm1_install_pro_bundle`,
`tm1_diff_process_with_file`, `tm1_export_process_to_git`,
`tm1_import_process_from_git`) live under `ti-development`; the `.pro` parser
handles tabs (572-575), parameters (560/561/590/637), variables (577-582) and
datasource (562-589).

<!-- TOOLS-AUTOGEN:START -->

## Tools (114)

### analysis (10)

- `tm1_analyze_callgraph` — Build a process call graph (ExecuteProcess/RunProcess) for a TI process
- `tm1_analyze_chore_graph` — Build downstream call graphs for every task of a TM1 chore
- `tm1_analyze_object_usage` — Find every reference to a cube or dimension across all TI processes (CellGet/Put, ViewExtract, ZeroOut, …) and cube rules (DB(), [dim].[el])
- `tm1_audit_complexity` — Bulk-scan TI processes and cube rules for complexity metrics (LOC, branches, max nesting, score)
- `tm1_audit_feeders` — Static heuristics (S1–S5) scan cube rules for overfeeding: wildcard brackets, feeders into consolidated
- `tm1_audit_naming` — Bulk-scan TM1 objects against IBM PA 2.0/3.1 naming conventions; reports hard violations only
- `tm1_check_v12_readiness` — Static gap-analysis against the TM1 / Planning Analytics v12 (Cloud Native) deprecation list
- `tm1_find_orphan_dimensions` — Identify dimensions not referenced by any cube — a model-hygiene check
- `tm1_invalidate_callgraph_cache` — Drop the in-memory ReferenceIndex cache used by tm1_analyze_callgraph / tm1_analyze_object_usage / tm1_analyze_chore_graph
- `tm1_trace_data_flow` — Trace data flow into and out of a cube in one call, instead of analyze_object_usage + N× get_process_code

### celldata (10)

- `tm1_check_feeders` — Check the feeders of a cell: verifies feeder coverage for the cells underlying this cell and returns the problematic ones with a fed flag — fed=false marks a br
- `tm1_check_writable_coords` — Pre-flight check before CellPutN/CellPutS
- `tm1_execute_mdx` — Execute an MDX query against the TM1 server and return structured cell data with axes (page-envelope shape consistent with list_*)
- `tm1_get_cell_value` — Get a single cell value from a TM1 cube by specifying element coordinates
- `tm1_get_view` — Execute a named cube view and return structured cell data with axes (page-envelope shape consistent with tm1_execute_mdx)
- `tm1_get_view_definition` — Return the structural definition of a cube view (MDX expression OR NativeView axes) WITHOUT executing it
- `tm1_sample_cells` — Return up to maxCells populated cells from a cube without guessing coordinates — builds a NON EMPTY CROSSJOIN MDX over the cube's dimensions and HEAD-limits it
- `tm1_trace_cell_calculation` — Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rul
- `tm1_trace_feeders` — Trace the feeders of a cell: returns the cells this cell feeds plus the feeder statements involved — answers 'which feeder statement fires from this cell, and w
- `tm1_write_cells` — Write one or more cell values directly to a TM1 cube via REST

### dimension-management (13)

- `tm1_bulk_upsert_elements` — Create or update multiple elements in a TM1 hierarchy in bulk (two-pass: leafs first, then consolidations)
- `tm1_create_dimension` — Create a new TM1 dimension with a default hierarchy of the same name
- `tm1_create_element` — Create a new element in a TM1 dimension hierarchy
- `tm1_create_element_attribute` — Create an element attribute definition (schema) on a TM1 hierarchy
- `tm1_create_hierarchy` — Create a new (alternate) hierarchy inside an existing dimension
- `tm1_delete_dimension` — Delete a TM1 dimension and all its hierarchies
- `tm1_delete_element` — Delete an element from a TM1 dimension hierarchy
- `tm1_delete_hierarchy` — Delete a hierarchy from a dimension
- `tm1_get_element_attribute_values` — Read all attribute values (Numeric/String/Alias) for a single element via MDX on the }ElementAttributes_{Dim} control cube
- `tm1_list_element_attributes` — List element attribute definitions of a TM1 hierarchy with their types (Numeric/String/Alias)
- `tm1_move_element` — Move an element to a new parent within a TM1 dimension hierarchy
- `tm1_update_element` — Update an existing element in a TM1 dimension hierarchy (name, type, or components)
- `tm1_update_element_attribute_value` — Set a single attribute value on an element by writing to the }ElementAttributes_{Dim} control cube

### fileops (5)

- `tm1_delete_file` — Delete a file from the TM1 server's blob/file storage
- `tm1_get_file_content` — Read the content of a file from the TM1 server's data directory
- `tm1_list_files` — List files in the TM1 server's data directory (blob/file storage)
- `tm1_search_files` — Search file names in the TM1 server's blob/file storage by prefix and/or substring
- `tm1_upload_file` — Upload (create or update) a file in the TM1 server's blob/file storage

### metadata (9)

- `tm1_get_ancestors` — Get all ancestors of an element via parent-walk
- `tm1_get_descendants` — Get descendants of a consolidation element
- `tm1_get_hierarchy` — Get hierarchy elements with parent-child relationships for a dimension
- `tm1_list_chores` — List chores in the TM1 server with schedule and assigned processes
- `tm1_list_cubes` — List cubes in the TM1 server
- `tm1_list_dimensions` — List dimensions (with their hierarchy names) in the TM1 server
- `tm1_list_processes` — List TurboIntegrator processes (with parameters) in the TM1 server
- `tm1_list_processes_grouped` — Group TI processes by name prefix to give a structural overview without listing every process
- `tm1_resolve_default_members` — Resolve N hierarchies' effective default members in parallel from one tool call; pass items:[{dimensionName}] with a single entry for a one-off lookup

### model-building (9)

- `tm1_check_cube_rule` — Validate the syntax of a TM1 cube rule WITHOUT applying it
- `tm1_clear_cube` — Clear a subset of cells from a cube
- `tm1_create_cube` — Create a new TM1 cube with the specified dimensions
- `tm1_delete_cube` — Delete a TM1 cube and all its data
- `tm1_get_all_cube_rules` — Bulk-load rules text for every cube in one call
- `tm1_get_cube_rules` — Get the current rules text for a TM1 cube
- `tm1_search_rules` — Regex search across cube rules text
- `tm1_set_cube_rules` — Create or replace the rules for a TM1 cube
- `tm1_unload_cube` — Unload a cube from memory

### operations (15)

- `tm1_cancel_job` — Cancel a running TM1 v12 job by its ID
- `tm1_cancel_thread` — Cancel a running TM1 server thread by its ID
- `tm1_diagnose_process_error` — One-call error diagnosis for a failed TI process: lists matching error logs, fetches their content, and optionally includes cascade-related sibling logs (same t
- `tm1_get_audit_log` — Fetch recent TM1 audit log entries (metadata/security changes: who changed what, when), newest first
- `tm1_get_cube_stats` — Read }StatsByCube metrics for one or more cubes (memory, populated cells, fed cells, feeder efficiency)
- `tm1_get_error_log_content` — Fetch the raw text of one TI error log file produced by a failed process run
- `tm1_get_message_log` — Fetch recent TM1 server message log entries, newest first
- `tm1_get_server_info` — Return TM1 server identity + curated configuration (TI, Rules, MTQ, JobQueuing, Memory, Logging, HTTP, Security) from /Configuration + /ActiveConfiguration
- `tm1_get_server_state` — Health-check style snapshot of the TM1 server in one call
- `tm1_get_transaction_log` — Fetch recent TM1 transaction log entries (cell writes), newest first
- `tm1_list_error_logs` — List TI process error log files on the TM1 server, newest first
- `tm1_list_jobs` — List active jobs (Activity) on a TM1 v12 database — the running tasks that replaced v11 threads
- `tm1_list_sessions` — List active sessions on the TM1 server with their associated user and threads
- `tm1_list_threads` — List active threads on the TM1 server (running processes, chores, MDX queries, etc.)
- `tm1_save_data` — Persist in-memory cube data to disk: SaveDataAll (all cubes) or CubeSaveData when `cube` is given

### scheduling (5)

- `tm1_create_chore` — Create a new TM1 chore with a schedule and list of TI processes to run
- `tm1_delete_chore` — Delete a TM1 chore permanently
- `tm1_execute_chore` — Execute a TM1 chore immediately, bypassing its schedule
- `tm1_toggle_chore` — Activate or deactivate a TM1 chore (enable/disable its schedule).
- `tm1_update_chore` — Update an existing TM1 chore

### security (8)

- `tm1_assign_client_group` — Assign a TM1 client to a group
- `tm1_create_client` — Create a new TM1 client (user)
- `tm1_delete_client` — Delete a TM1 client (user)
- `tm1_get_client` — Get details for a single TM1 client (user) including group memberships.
- `tm1_list_clients` — List TM1 clients (users)
- `tm1_list_groups` — List TM1 groups
- `tm1_remove_client_group` — Remove a TM1 client from a group
- `tm1_update_client` — Update a TM1 client

### subsets (5)

- `tm1_create_subset` — Create a public TM1 subset
- `tm1_delete_subset` — Delete a public TM1 subset
- `tm1_get_subset` — Get a single TM1 subset with its MDX expression (if any) and resolved element list
- `tm1_list_subsets` — List public + private subsets of a TM1 hierarchy
- `tm1_update_subset` — Update a public TM1 subset (partial)

### ti-development (21)

- `tm1_check_process_code` — Validate TI process code WITHOUT saving it on the server (POST /api/v1/CompileProcess unbound)
- `tm1_compile_process` — Compile a TI process to validate its syntax without executing it
- `tm1_copy_process` — Copy a TI process (including variables and datasource) to a new name
- `tm1_delete_process` — Delete a TurboIntegrator process from the TM1 server
- `tm1_diff_process_with_file` — Compare an installed TI process on the server against a local .pro file
- `tm1_diff_processes` — Compare two installed TI processes tab-by-tab (Prolog/Metadata/Data/Epilog)
- `tm1_execute_process` — Execute a TurboIntegrator process on the TM1 server with optional parameters
- `tm1_export_process_to_git` — Serialize a TM1 process to the tm1-git two-file layout: a '{name}.json' (parameters, variables, datasource) plus a '{name}.ti' (Prolog/Metadata/Data/Epilog as p
- `tm1_export_process_to_pro` — Reverse of tm1_import_pro_file: serialize a TM1 process back to a .pro file body
- `tm1_get_all_processes_code` — Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) fo
- `tm1_get_process` — Native full read of a TI process — the read-twin of tm1_upsert_process
- `tm1_get_process_code` — Get the source code of all four tabs (Prolog, Metadata, Data, Epilog) of a TI process
- `tm1_get_process_datasource` — Get the data source configuration of a TurboIntegrator process
- `tm1_get_process_parameters` — Get the parameters of a TurboIntegrator process including names, types and defaults
- `tm1_get_process_variables` — Get the variables (column-name mapping for ASCII/ODBC sources) of a TurboIntegrator process
- `tm1_import_pro_file` — Parse a TM1 .pro file (Tabs / Parameters / Variables / DataSource) and deploy the process in one call
- `tm1_import_process_from_git` — Deploy a TM1 process from the tm1-git two-file layout ('{name}.json' + '{name}.ti')
- `tm1_install_pro_bundle` — Install all .pro files from a directory in one call
- `tm1_search_code` — Regex search across all TI process code (Prolog/Metadata/Data/Epilog)
- `tm1_upsert_process` — Atomic-style create-or-update for a TI process
- `tm1_validate_process_refs` — Scan a TI process (live, by name, or from .pro) for cube/dimension references in well-known TI functions (CellGetN/S, CellPutN/S, ViewCreate, DimensionElementIn

### views (4)

- `tm1_create_mdx_view` — Create a public MDX-based view on a cube
- `tm1_create_native_view` — Create a public native (subset-based) view on a cube — the classic view type used as TI process datasource
- `tm1_delete_view` — Delete a public view from a cube
- `tm1_list_views` — List public and private views defined on a cube

<!-- TOOLS-AUTOGEN:END -->
