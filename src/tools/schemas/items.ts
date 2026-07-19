// Zod schemas for the per-item types returned by the paginated list_* tools and
// the result payloads of the other tools. Mirrors the TypeScript interfaces in
// src/types.ts so the runtime outputSchema and the static type cannot drift.
//
// Schemas are intentionally permissive (`.passthrough()` where the upstream
// REST surface is loose) — TM1 occasionally returns extra fields and we don't
// want validation to break an otherwise useful payload.
//
// This module is a RE-EXPORT BARREL. The schema definitions live in the
// per-category `items-<domain>.ts` files so no single file grows unwieldy;
// every existing importer keeps importing from `./schemas/items.js` unchanged.
export * from "./items-common.js";
export * from "./items-metadata.js";
export * from "./items-processes.js";
export * from "./items-cells.js";
export * from "./items-views.js";
export * from "./items-subsets.js";
export * from "./items-scheduling.js";
export * from "./items-security.js";
export * from "./items-monitoring.js";
export * from "./items-fileops.js";
export * from "./items-analysis.js";
