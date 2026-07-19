// Subset-domain schema: list item for tm1_list_subsets / tm1_get_subset.
import { z } from "zod";

export const SubsetItemSchema = z.object({
  name: z.string(),
  dimensionName: z.string(),
  hierarchyName: z.string(),
  private: z.boolean(),
  expression: z.string().optional(),
  elements: z.array(z.string()),
  alias: z.string().optional(),
});
