// MCP tool annotations. Hints to clients about tool behavior — not security
// guarantees. See https://modelcontextprotocol.io/specification on annotations.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// R2-21: TM1-specific annotation extension carrying machine-readable v11/v12
// compatibility metadata. MCP's ToolAnnotationsSchema is a non-strict z.object,
// so unknown keys pass through JSON serialization to clients (Zod strips them
// only on .parse, and the SDK serializes on send without re-parsing).
//
// Semantics:
//   "v11"   — only meaningful on v11 instances (e.g. .pro file ops, v12-readiness)
//   "v12"   — only meaningful on v12 (Cloud Native) instances
//   "v11+"  — works on v11 and later (default; usually omitted)
//   "v12+"  — works on v12 and later (forward-looking new APIs)
//
// Clients (or wrapping agents) can read this from the tool listing and gate
// invocation. The server does not refuse mismatched calls — annotations are
// hints per MCP spec.
export type Tm1RequiresVersion = "v11" | "v12" | "v11+" | "v12+";

export interface Tm1ToolAnnotations extends ToolAnnotations {
  requiresVersion?: Tm1RequiresVersion;
}

// Apply requiresVersion to a base annotation preset without mutating it.
export function withVersion(
  base: ToolAnnotations,
  version: Tm1RequiresVersion,
): Tm1ToolAnnotations {
  return { ...base, requiresVersion: version };
}

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
