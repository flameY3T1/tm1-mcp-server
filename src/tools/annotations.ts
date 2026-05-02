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

// delete_*, clear_*, unload_*, cancel_*, remove_*, invalidate_*, execute_* (TI side effects).
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};
