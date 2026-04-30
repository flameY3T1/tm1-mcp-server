import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildChoreGraph } from "../../lib/callgraph/choreGraph.js";
import type { CallGraphNode } from "../../lib/callgraph/callGraph.js";

function serializeNode(node: CallGraphNode): unknown {
  return {
    process: node.process,
    cycle: node.cycle,
    depthLimitReached: node.depthLimitReached,
    incomingEdge: node.incomingEdge
      ? {
          caller: node.incomingEdge.caller,
          callee: node.incomingEdge.callee,
          section: node.incomingEdge.section,
          line: node.incomingEdge.line,
          funcName: node.incomingEdge.funcName,
          snippet: node.incomingEdge.snippet,
          params: node.incomingEdge.params,
          effectiveParams: node.incomingEdge.effectiveParams,
        }
      : null,
    env: node.env ? Object.fromEntries(node.env.entries()) : undefined,
    children: node.children.map(serializeNode),
  };
}

export function registerAnalyzeChoreGraph(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_analyze_chore_graph",
    "Build downstream call graphs for every task of a TM1 chore. Each task's tree is seeded with the chore's task params (literals) which propagate through ExecuteProcess calls. Returns one tree per task plus the chore's own params per task.",
    {
      chore: z.string().describe("Chore name (case-insensitive)"),
      includeSystem: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control objects in the graph. Default: false."),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Index control objects when building the index. Default: false."),
    },
    async ({ chore, includeSystem, includeControl }) => {
      try {
        const index = await buildIndexFromTM1(tm1Client, { includeControl });
        const graph = buildChoreGraph(index, chore, { includeSystem });
        if (!graph) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  warning: `Chore "${chore}" not found.`,
                  indexedChoreCount: index.choreTasks.size,
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  choreName: graph.choreName,
                  tasks: graph.tasks.map((t) => ({
                    step: t.step,
                    processName: t.processName,
                    choreParams: t.choreParams,
                    tree: serializeNode(t.tree),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
