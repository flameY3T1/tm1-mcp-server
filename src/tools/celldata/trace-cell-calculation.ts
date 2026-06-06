import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerTraceCellCalculation(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_trace_cell_calculation",
    [
      "Trace how a cell value is calculated: recursive component tree with per-component type (Consolidation/Rule/Simple), status (Null/Data/Error), value, and the rule statements that populate it — answers 'why is this cell X / empty?'.",
      "The tree is truncated client-side via maxDepth/maxComponents; truncated=true marks cut branches (re-run with the branch tuple as new start cell to drill deeper).",
      "Elements address the default hierarchy, in cube dimension order (discover with tm1_list_cubes).",
      "v11 only. Related: tm1_check_feeders / tm1_trace_feeders for feeder issues, tm1_get_cube_rules for the full rule text.",
    ].join(" "),
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      elements: z
        .array(z.string())
        .describe("Element names for each dimension of the cube, in cube dimension order"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Maximum component-tree depth to return (default 3). Deep consolidations explode quickly."),
      maxComponents: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum components per node (default 20). Excess children are dropped and the node marked truncated."),
    },
    async ({ cubeName, elements, maxDepth, maxComponents }, extra) => {
      const tree = await withToolHint(
        tm1Client.cells.traceCellCalculation(cubeName, elements, maxDepth, maxComponents, {
          signal: extra?.signal,
        }),
        `TraceCellCalculation failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes; alternate hierarchies are not supported. On v12 this action is unavailable.`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tree, null, 2) }],
      };
    },
  );
}
