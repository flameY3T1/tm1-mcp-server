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

interface SummaryEntry {
  process: string;
  depthMin: number;
  depthMax: number;
  occurrences: number;
  cycle: boolean;
  depthLimitReached: boolean;
}

function summarize(root: CallGraphNode): {
  root: string;
  totalNodes: number;
  uniqueProcesses: number;
  maxDepth: number;
  cyclesDetected: number;
  depthLimitsHit: number;
  processes: SummaryEntry[];
} {
  const map = new Map<string, SummaryEntry>();
  let totalNodes = 0;
  let maxDepth = 0;
  let cyclesDetected = 0;
  let depthLimitsHit = 0;

  function walk(node: CallGraphNode, depth: number): void {
    totalNodes++;
    if (depth > maxDepth) maxDepth = depth;
    const isCycle = !!node.cycle;
    const isDepthLimit = !!node.depthLimitReached;
    if (isCycle) cyclesDetected++;
    if (isDepthLimit) depthLimitsHit++;

    const existing = map.get(node.process);
    if (existing) {
      existing.occurrences++;
      if (depth < existing.depthMin) existing.depthMin = depth;
      if (depth > existing.depthMax) existing.depthMax = depth;
      existing.cycle = existing.cycle || isCycle;
      existing.depthLimitReached = existing.depthLimitReached || isDepthLimit;
    } else {
      map.set(node.process, {
        process: node.process,
        depthMin: depth,
        depthMax: depth,
        occurrences: 1,
        cycle: isCycle,
        depthLimitReached: isDepthLimit,
      });
    }

    for (const child of node.children) walk(child, depth + 1);
  }

  walk(root, 0);

  const processes = Array.from(map.values()).sort((a, b) => {
    if (a.depthMin !== b.depthMin) return a.depthMin - b.depthMin;
    return b.occurrences - a.occurrences;
  });

  return {
    root: root.process,
    totalNodes,
    uniqueProcesses: map.size,
    maxDepth,
    cyclesDetected,
    depthLimitsHit,
    processes,
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
      mode: z
        .enum(["full", "summary"])
        .optional()
        .default("full")
        .describe(
          "Output mode. 'full' returns nested tree (large for deep graphs). 'summary' returns flat per-process aggregates (occurrences, depthMin/Max, cycle/depthLimit flags) — use for triage before pulling a full tree.",
        ),
    },
    async ({ start, direction, maxDepth, includeSystem, includeControl, mode }) => {
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
        const payload =
          mode === "summary"
            ? { start, direction, mode, summary: summarize(tree) }
            : { start, direction, mode, tree: serializeNode(tree) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
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
