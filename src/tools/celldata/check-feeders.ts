import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

export function registerCheckFeeders(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_check_feeders",
    [
      "Check the feeders of a cell: returns the cells fed by this cell, each with a fed flag — fed=false marks a broken or missing feeder (the classic cause of empty consolidated/rule cells).",
      "Per-cell runtime check; complements tm1_audit_feeders (static rule analysis).",
      "Elements address the default hierarchy, in cube dimension order (discover with tm1_list_cubes).",
      "v11 only. Related: tm1_trace_feeders (statements involved), tm1_trace_cell_calculation (why has this cell value X).",
    ].join(" "),
    {
      cubeName: z.string().describe("Name of the TM1 cube"),
      elements: z
        .array(z.string())
        .describe("Element names for each dimension of the cube, in cube dimension order"),
    },
    async ({ cubeName, elements }, extra) => {
      const fedCells = await withToolHint(
        tm1Client.cells.checkFeeders(cubeName, elements, { signal: extra?.signal }),
        `CheckFeeders failed for cube '${cubeName}'. Verify dimension order/elements via tm1_list_cubes; alternate hierarchies are not supported. On v12 this action is unavailable.`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { count: fedCells.length, unfedCount: fedCells.filter((c) => !c.fed).length, fedCells },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
