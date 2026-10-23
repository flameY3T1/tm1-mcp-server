// Sandbox domain. The client maps TM1's PascalCase entity to these camelCase
// fields, and reports a state flag the server did not send as null rather than
// guessing it.
import { z } from "zod";

export const SandboxSchema = z.object({
  name: z.string(),
  includeInSandboxDimension: z.boolean().nullable(),
  isActive: z.boolean().nullable(),
  isLoaded: z.boolean().nullable(),
  isQueued: z.boolean().nullable(),
});
export type SandboxInfo = z.infer<typeof SandboxSchema>;

// One cell that differs between base data and a sandbox.
export const SandboxDifferenceSchema = z.object({
  coordinates: z.array(z.string()),
  base: z.union([z.number(), z.string(), z.null()]),
  sandbox: z.union([z.number(), z.string(), z.null()]),
  change: z.number().optional(),
});
export type SandboxDifference = z.infer<typeof SandboxDifferenceSchema>;
