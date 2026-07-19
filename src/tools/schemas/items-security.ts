// Security-domain schemas: client and group list items.
import { z } from "zod";

export const ClientItemSchema = z
  .object({
    Name: z.string(),
    FriendlyName: z.string().optional(),
    Type: z.string().optional(),
    Enabled: z.boolean().optional(),
    Groups: z.array(z.object({ Name: z.string() })).optional(),
    groupCount: z.number().int().optional(),
  })
  .passthrough();

export const GroupItemSchema = z
  .object({
    Name: z.string(),
    Clients: z.array(z.object({ Name: z.string() })).optional(),
    clientCount: z.number().int().optional(),
  })
  .passthrough();
