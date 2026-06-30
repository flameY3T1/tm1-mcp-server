import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { traceDataFlow } from "../../lib/callgraph/dataFlow.js";

export function registerTraceDataFlow(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_trace_data_flow",
    [
      "Trace data flow into and out of a cube in one call, instead of analyze_object_usage + N× get_process_code.",
      "downstream: processes that READ the cube and which cubes they WRITE to (where the data flows next).",
      "upstream: processes that WRITE the cube and where they SOURCE data (read cubes + datasource).",
      "Combines code-level CellGet/CellPut/DB access with each process's datasource, so view-sourced reads",
      "(a TM1CubeView datasource with no CellGet in the code) are caught too. Read-only.",
    ].join(" "),
    {
      cubeName: z.string().describe("Cube to trace (case-insensitive)"),
      direction: z
        .enum(["upstream", "downstream", "both"])
        .optional()
        .default("both")
        .describe(
          "'downstream': readers → their write targets. 'upstream': writers → their data sources. 'both' (default).",
        ),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control processes (names starting with '}') when building the index. Default: false."),
    },
    async ({ cubeName, direction, includeControl }) => {
      const [index, dsList] = await Promise.all([
        buildIndexFromTM1(tm1Client, { includeControl }),
        tm1Client.processes.listDataSources(includeControl),
      ]);

      const flow = traceDataFlow(index, dsList, cubeName, direction);

      const empty =
        (flow.counts.upstream ?? 0) === 0 && (flow.counts.downstream ?? 0) === 0;
      const hint = empty
        ? `No data flow found for '${cubeName}'. Check the cube name, or set includeControl=true if it is touched only by control (}) processes.`
        : undefined;

      const payload = { ...flow, ...(hint ? { hint } : {}) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
