// Shared primitives referenced across the per-category item schemas.
// Split out of items.ts so every category file can import the same
// enums/unions and the uniform mutation envelope without a cycle.
import { z } from "zod";

export const ELEMENT_TYPE = z.enum(["Numeric", "String", "Consolidated"]);
export const PARAM_TYPE = z.enum(["String", "Numeric"]);

// Hoisted: shared by transaction-log entries and MDX/cell tools below.
export const CellValueSchema = z.union([z.string(), z.number(), z.null()]);

// ── Phase 2h: uniform mutation envelope ──────────────────────────────────────
// Every create/update/delete/execute tool returns {success: true, ...identifying fields}
// on success. Passthrough so per-tool extras (cellsWritten, parameterCount,
// updatedTabs etc.) flow through without bespoke schemas.
export const MutationResultSchema = z
  .object({
    success: z.boolean(),
  })
  .passthrough();
