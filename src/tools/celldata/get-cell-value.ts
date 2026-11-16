import { z } from "zod";
import { CellValueSchema } from "../schemas/items.js";
import { READ_ONLY } from "../annotations.js";
import { defineTool } from "../define-tool.js";
import { cleanSandboxName } from "../../lib/sandbox-policy.js";
export const registerGetCellValue = defineTool({
  name: "tm1_get_cell_value",
  description: [
    "Get a single cell value from a TM1 cube by specifying element coordinates.",
    "Discover dimension order with tm1_list_cubes (cube.dimensions).",
    "Related: tm1_execute_mdx for slices/grids, tm1_sample_cells to probe sparsity without enumerating, tm1_write_cells for the inverse operation.",
  ],
  annotations: READ_ONLY,
  output: {
    value: CellValueSchema.describe("Cell value (string, number, or null)"),
  },
  input: {
    cubeName: z.string().describe("Name of the TM1 cube"),
    elements: z
      .array(z.string())
      .describe(
        "One element per cube dimension, in cube order. Sandboxes may be left out (bound to Base, or to `sandbox`).",
      ),
    sandbox: z
      .string()
      .optional()
      .describe("Read from this sandbox instead of base data"),
  },
  handler: async ({ cubeName, elements, sandbox }, tm1Client) => {
    const value = await tm1Client.cells.getValue(
      cubeName,
      elements,
      cleanSandboxName(sandbox),
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ value }) }],
    };
  },
});
