import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { traceDataFlow } from "../../lib/callgraph/dataFlow.js";
import { buildDatasourceMembership, type DatasourceMembership } from "../../lib/callgraph/datasourceMembership.js";
import { membersFromAxis } from "../../lib/callgraph/mdxMembers.js";

export function registerTraceDataFlow(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_trace_data_flow",
    [
      "Trace data flow into and out of a cube in one call, instead of analyze_object_usage + N× get_process_code.",
      "downstream: processes that READ the cube and which cubes they WRITE to (where the data flows next).",
      "upstream: processes that WRITE the cube and where they SOURCE data (read cubes + datasource).",
      "Combines code-level CellGet/CellPut/DB access with each process's datasource, so view-sourced reads",
      "(a TM1CubeView datasource with no CellGet in the code) are caught too. Read-only.",
      "Pass element+dimension to also get which processes touch that element via in-code subset-membership calls.",
      "Each touching process is tagged access=source|write|zero-out|indeterminate so a zero-out is not mistaken for a read-source.",
      "Element tracing also resolves stored view/subset datasources (native-view titles + static subsets exactly; MDX views/subsets by literal member; computed selectors are flagged, not resolved).",
      "With resolveComputed=true, computed native-view axis selectors are resolved to exact members (via 'view-native-computed'); otherwise they stay flagged in computedInProcesses.",
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
      element: z
        .string()
        .optional()
        .describe("Element name to trace. With 'dimension', results add which processes touch this element via in-code subset-membership calls (SubsetElementInsert/Add/Delete)."),
      dimension: z
        .string()
        .optional()
        .describe("Owning dimension of 'element' (required when 'element' is set)."),
      resolveDatasourceMembership: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "When tracing an element, also resolve server-side view/subset datasources (extra fetches). Default true; set false to skip for speed.",
        ),
      resolveComputed: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "When tracing an element, additionally RESOLVE computed native-view axis selectors (e.g. TM1FILTERBYLEVEL/DESCENDANTS) by live-evaluating just that dimension's set against the view's cube (read-only). Off by default (extra queries). Only affects native-view axis expressions; stored subsets are already resolved exactly.",
        ),
      elementAccess: z
        .array(z.enum(["source", "write", "zero-out", "indeterminate"]))
        .optional()
        .describe("Element roles to include (default source+write+zero-out). Add 'indeterminate' to also list processes that build the subset but whose use we could not classify (NOT proof of no use)."),
    },
    async ({ cubeName, direction, includeControl, element, dimension, resolveDatasourceMembership, resolveComputed, elementAccess }) => {
      if (element && !dimension) {
        return { isError: true, content: [{ type: "text" as const, text: "When 'element' is set, 'dimension' is required (element names are only unique within a dimension)." }] };
      }
      const [index, dsList] = await Promise.all([
        buildIndexFromTM1(tm1Client, { includeControl }),
        tm1Client.processes.listDataSources(includeControl),
      ]);

      let datasourceMembership: DatasourceMembership | undefined;
      if (element && dimension && resolveDatasourceMembership) {
        datasourceMembership = await buildDatasourceMembership(
          {
            getViewDefinition: (cube, view) => tm1Client.views.getDefinition(cube, view),
            getSubset: (dim, hier, sub) => tm1Client.subsets.get(dim, hier, sub),
            ...(resolveComputed
              ? {
                  evaluateSetExpression: async (cube: string, dim: string, mdxSet: string): Promise<string[]> => {
                    const res = await tm1Client.cells.executeMdx(
                      `SELECT {${mdxSet}} ON 0 FROM [${cube.replace(/\]/g, "]]")}]`,
                      1,
                    );
                    return membersFromAxis(res, dim);
                  },
                }
              : {}),
          },
          dsList,
        );
      }

      const flow = traceDataFlow(
        index,
        dsList,
        cubeName,
        direction,
        element && dimension
          ? {
              element: { dimension, name: element },
              ...(elementAccess ? { elementAccess } : {}),
              ...(datasourceMembership ? { datasourceMembership } : {}),
            }
          : undefined,
      );

      // An element filter that found hits is meaningful output on its own — don't let
      // a cube with no up/downstream flow overwrite it with a contradictory "not found" hint.
      const elementHasHits = (flow.element?.processes.length ?? 0) > 0;
      const empty =
        !elementHasHits &&
        (flow.counts.upstream ?? 0) === 0 &&
        (flow.counts.downstream ?? 0) === 0;
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
