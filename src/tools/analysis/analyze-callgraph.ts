import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildCallGraph, type CallGraphNode } from "../../lib/callgraph/callGraph.js";

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

export function registerAnalyzeCallgraph(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_analyze_callgraph",
    "Build a process call graph (ExecuteProcess/RunProcess) for a TI process. direction='downstream' shows what `start` calls (with parameter env propagation: literal/passthrough/dynamic). direction='upstream' shows callers. Returns nested JSON tree.",
    {
      start: z.string().describe("Process name to start traversal from"),
      direction: z.enum(["downstream", "upstream"]).default("downstream"),
      maxDepth: z.number().int().min(1).max(50).optional().default(20),
      includeSystem: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control objects (names starting with '}') in graph. Default: false."),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Index control processes/cubes/chores (broader graph). Default: false."),
    },
    async ({ start, direction, maxDepth, includeSystem, includeControl }) => {
      try {
        const index = await buildIndexFromTM1(tm1Client, { includeControl });
        const lc = start.toLowerCase();
        if (
          !index.processParams.has(lc) &&
          !index.bySourceProcess.has(lc) &&
          !index.byProcess.has(lc)
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  warning: `Process "${start}" not found in index.`,
                  indexedProcessCount: index.processParams.size,
                }),
              },
            ],
          };
        }
        const tree = buildCallGraph(index, start, { direction, maxDepth, includeSystem });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ start, direction, tree: serializeNode(tree) }, null, 2),
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
