// Sandbox-domain schemas: list items and the compare payload.
import { z } from "zod";
import {
  SandboxDifferenceSchema,
  SandboxSchema,
} from "../../schemas/sandboxes.js";

export const SandboxItemSchema = SandboxSchema.extend({
  managed: z
    .boolean()
    .describe(
      "Name starts with TM1_SANDBOX_PREFIX: writable by this server in sandbox mode",
    ),
});

export const SandboxCompareSchema = {
  sandbox: z.string(),
  cellsCompared: z.number().int(),
  differences: z.number().int(),
  truncated: z
    .boolean()
    .describe("True when more cells differ than maxDifferences returns"),
  cells: z.array(SandboxDifferenceSchema),
};
