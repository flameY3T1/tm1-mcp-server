// Canonical wire/domain schemas — the single definition of every shape that
// both the TM1 client and the tool layer need.
//
// Before this existed the same shapes were written twice: a hand-kept
// interface in src/types.ts for the client, and a hand-kept Zod object in
// src/tools/schemas/items-*.ts for the published outputSchema. They drifted
// exactly the way you would expect — `lockType` sat in the read shape for
// months without ever being on the wire, and removing it meant editing two
// files that had no link between them.
//
// Now the Zod object is the definition and the TypeScript type is `z.infer` of
// it. src/types.ts re-exports those types, so every existing import keeps
// working; src/tools/schemas/items-*.ts re-export the schemas.
export * from "./common.js";
export * from "./cells.js";
export * from "./metadata.js";
export * from "./monitoring.js";
export * from "./processes.js";
export * from "./scheduling.js";
export * from "./security.js";
export * from "./subsets.js";
export * from "./views.js";
export * from "./sandboxes.js";
