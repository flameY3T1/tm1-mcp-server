import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerTraceFeeders(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_trace_feeders",
    [
      "Trace the feeders of a cell: returns the cells this cell feeds plus the feeder statements involved — answers 'which feeder statement fires from this cell, and where to'.",
      "Use when a rule cell stays empty under SKIPCHECK: trace the source cell to see whether its feeder reaches the target.",
      "Elements address the default hierarchy, in cube dimension order (discover with tm1_list_cubes).",
      "v11 only. Related: tm1_check_feeders (fed/unfed flags), tm1_audit_feeders (static analysis).",
    ].join(" "),
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      elements: z
        .array(z.string())
        .describe("Element names for each dimension of the cube, in cube dimension order"),
    },
    async ({ cubeName, elements }, extra) => {
      const result = await withToolHint(
        tm1Client.cells.traceFeeders(cubeName, elements, { signal: extra?.signal }),
        `TraceFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes; alternate hierarchies are not supported. On v12 this action is unavailable.`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: result.fedCells.length, ...result }, null, 2),
          },
        ],
      };
    },
  );
}
