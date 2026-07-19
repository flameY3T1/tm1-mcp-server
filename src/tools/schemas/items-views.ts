// View-domain schemas: list item and the view-definition (MDX/Native) result.
import { z } from "zod";

export const ViewItemSchema = z.object({
  name: z.string(),
  mdx: z.string().optional(),
  private: z.boolean(),
});

const ViewAxisSubsetRefSchema = z.object({
  dimensionName: z.string().optional(),
  hierarchyName: z.string().optional(),
  subsetName: z.string().optional(),
  expression: z.string().optional(),
});

const ViewTitleRefSchema = ViewAxisSubsetRefSchema.extend({
  selectedElement: z.string().optional(),
});

export const ViewDefinitionResultSchema = z.object({
  cubeName: z.string(),
  viewName: z.string(),
  private: z.boolean(),
  type: z.enum(["MDX", "Native"]),
  mdx: z.string().optional(),
  native: z
    .object({
      titles: z.array(ViewTitleRefSchema),
      columns: z.array(ViewAxisSubsetRefSchema),
      rows: z.array(ViewAxisSubsetRefSchema),
    })
    .optional(),
});
