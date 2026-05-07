import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildCallGraph, type CallGraphNode, type EffectiveValue } from "../../lib/callgraph/callGraph.js";
import type { CallParam } from "../../lib/callgraph/referenceIndex.js";
import { isSecretName, MASK, maskCodeLine } from "../../lib/mask-secrets.js";

function maskParams(params: readonly CallParam[]): CallParam[] {
  return params.map((p) =>
    isSecretName(p.name)
      ? {
          ...p,
          valueRaw: MASK,
          resolution:
            p.resolution.kind === "literal" ? { kind: "literal" as const, value: MASK } : p.resolution,
        }
      : p,
  );
}

function maskEffective(
  eff: ReadonlyArray<{ name: string; effective: EffectiveValue; valueRaw: string }>,
): Array<{ name: string; effective: EffectiveValue; valueRaw: string }> {
  return eff.map((e) =>
    isSecretName(e.name)
      ? {
          ...e,
          valueRaw: MASK,
          effective: e.effective.kind === "literal" ? { kind: "literal" as const, value: MASK } : e.effective,
        }
      : e,
  );
}

function maskEnv(env: Map<string, EffectiveValue>): Record<string, EffectiveValue> {
  const out: Record<string, EffectiveValue> = {};
  for (const [k, v] of env.entries()) {
    out[k] = isSecretName(k) && v.kind === "literal" ? { kind: "literal", value: MASK } : v;
  }
  return out;
}

interface CompactNode {
  process: string;
  cycle?: boolean;
  depthLimitReached?: boolean;
  children: CompactNode[];
}

function serializeCompact(node: CallGraphNode): CompactNode {
  const out: CompactNode = {
    process: node.process,
    children: node.children.map(serializeCompact),
  };
  if (node.cycle) out.cycle = true;
  if (node.depthLimitReached) out.depthLimitReached = true;
  return out;
}

function serializeNode(node: CallGraphNode, mask: boolean): unknown {
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
          snippet: mask ? maskCodeLine(node.incomingEdge.snippet) : node.incomingEdge.snippet,
          params: mask ? maskParams(node.incomingEdge.params) : node.incomingEdge.params,
          effectiveParams: node.incomingEdge.effectiveParams
            ? mask
              ? maskEffective(node.incomingEdge.effectiveParams)
              : node.incomingEdge.effectiveParams
            : undefined,
        }
      : null,
    env: node.env ? (mask ? maskEnv(node.env) : Object.fromEntries(node.env.entries())) : undefined,
    children: node.children.map((c) => serializeNode(c, mask)),
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
        .enum(["full", "summary", "compact"])
        .optional()
        .default("full")
        .describe(
          "Output mode. 'full' returns nested tree with incomingEdge/env/effectiveParams (large for deep graphs). 'summary' returns flat per-process aggregates (occurrences, depthMin/Max, cycle/depthLimit flags) for triage. 'compact' returns the nested tree but only {process, cycle?, depthLimitReached?, children[]} — drops params, env, snippets, effectiveParams. Use compact for structural overviews where call shape matters but param values do not.",
        ),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact param values whose name matches /pass|pwd|secret|token|key|credential|auth/i to '***'. Also masks the inline snippet. Default: true. Set false only when debugging credential propagation locally.",
        ),
    },
    async ({ start, direction, maxDepth, includeSystem, includeControl, mode, maskSecrets }) => {
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
      let payload: Record<string, unknown>;
      if (mode === "summary") {
        payload = { start, direction, mode, maskSecrets, summary: summarize(tree) };
      } else if (mode === "compact") {
        payload = { start, direction, mode, tree: serializeCompact(tree) };
      } else {
        payload = { start, direction, mode, maskSecrets, tree: serializeNode(tree, maskSecrets) };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
