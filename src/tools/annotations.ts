// MCP tool annotations. Hints to clients about tool behavior — not security
// guarantees. See https://modelcontextprotocol.io/specification on annotations.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// GET / list / search / analyze / validate / compile / diff — no server-side state change.
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// PUT-style updates: same input -> same end state. update_*, upsert_*, bulk_upsert_*.
export const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

// POST-style creates / non-idempotent writes: create_*, copy_*, toggle_*, write_cells.
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

// delete_*, clear_*, unload_*, cancel_*, remove_*, execute_* (TI side effects).
// Note: "destructive" per MCP spec = "may perform destructive updates to its
// environment". This covers two distinct shapes in TM1:
//   1. Irreversible object/data removal (delete_*, clear_*) — true destructive
//   2. Irreversible data mutation via side-effects (execute_process,
//      execute_chore) — process runs and writes through to cubes; output is
//      not recoverable by undoing the tool call.
// Both surface to the client as a single destructiveHint=true so prompts
// before invocation warn either way. tm1_invalidate_callgraph_cache was
// previously here but is in fact recoverable (cache rebuilds on next read)
// and is now classified IDEMPOTENT_WRITE.
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
