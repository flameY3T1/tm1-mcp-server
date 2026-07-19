// Scheduling-domain schema: chore list item for tm1_list_chores.
import { z } from "zod";

export const ChoreItemSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  startTime: z.string(),
  frequency: z.string(),
  // In compact mode (tm1_list_chores compact=true) the full processes[] array
  // is replaced by processCount. Both fields are therefore optional at schema
  // level; the tool guarantees exactly one is present.
  processes: z
    .array(
      z.object({
        name: z.string(),
        parameters: z.record(z.string(), z.union([z.string(), z.number()])),
      }),
    )
    .optional(),
  processCount: z.number().int().optional(),
});
