// Zod schemas for the per-item types returned by paginated list_* tools.
// Mirrors the TypeScript interfaces in src/types.ts so the runtime
// outputSchema and the static type cannot drift.
//
// Schemas are intentionally permissive (`.passthrough()` where the upstream
// REST surface is loose) — TM1 occasionally returns extra fields and we
// don't want validation to break a useful payload.
import { z } from "zod";

export const ELEMENT_TYPE = z.enum(["Numeric", "String", "Consolidated"]);
export const PARAM_TYPE = z.enum(["String", "Numeric"]);

export const CubeItemSchema = z.object({
  name: z.string(),
  dimensions: z.array(z.string()),
});

export const DimensionItemSchema = z.object({
  name: z.string(),
  hierarchies: z.array(z.string()),
});

export const ProcessParameterSchema = z.object({
  name: z.string(),
  type: PARAM_TYPE,
  defaultValue: z.union([z.string(), z.number()]),
  prompt: z.string().optional(),
});

export const ProcessItemSchema = z.object({
  name: z.string(),
  parameters: z.array(ProcessParameterSchema),
});

export const ChoreItemSchema = z.object({
  name: z.string(),
  active: z.boolean(),
  startTime: z.string(),
  frequency: z.string(),
  processes: z.array(
    z.object({
      name: z.string(),
      parameters: z.record(z.string(), z.union([z.string(), z.number()])),
    }),
  ),
});

export const ClientItemSchema = z
  .object({
    Name: z.string(),
    FriendlyName: z.string().optional(),
    Type: z.string().optional(),
    Enabled: z.boolean().optional(),
    Groups: z.array(z.object({ Name: z.string() })).optional(),
  })
  .passthrough();

export const GroupItemSchema = z
  .object({
    Name: z.string(),
    Clients: z.array(z.object({ Name: z.string() })).optional(),
  })
  .passthrough();

export const ViewItemSchema = z.object({
  name: z.string(),
  mdx: z.string().optional(),
  private: z.boolean(),
});

export const SubsetItemSchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  hierarchyName: z.string(),
  private: z.boolean(),
  expression: z.string().optional(),
  elements: z.array(z.string()),
  alias: z.string().optional(),
});

export const ThreadItemSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  state: z.string(),
  function: z.string(),
  objectName: z.string(),
  elapsedTime: z.string().optional(),
  objectType: z.string().optional(),
  lockType: z.string().optional(),
  waitTime: z.string().optional(),
  info: z.string().optional(),
  context: z.string().optional(),
});

export const SessionItemSchema = z.object({
  id: z.string(),
  user: z.string(),
  active: z.boolean().optional(),
  threads: z.array(ThreadItemSchema),
});

export const ElementAttributeValueSchema = z.object({
  elementName: z.string(),
  attributeName: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
});

// listFiles returns bare strings (file/folder names).
export const FilenameItemSchema = z.string();
