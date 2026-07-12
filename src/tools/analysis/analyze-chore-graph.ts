import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { buildIndexFromTM1 } from "../../lib/callgraph/tm1-adapter.js";
import { buildChoreGraph } from "../../lib/callgraph/choreGraph.js";
import type { CallGraphNode, EffectiveValue } from "../../lib/callgraph/callGraph.js";
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

function maskChoreParams<T extends Record<string, unknown>>(params: readonly T[] | undefined): T[] | undefined {
  if (!params) return params;
  return params.map((p) => {
    const name = (p.Name ?? p.name) as string | undefined;
    return name && isSecretName(name) ? ({ ...p, Value: MASK, value: MASK }) : p;
  });
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

export function registerAnalyzeChoreGraph(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_analyze_chore_graph",
    "Build downstream call graphs for every task of a TM1 chore. Each task's tree is seeded with the chore's task params (literals) which propagate through ExecuteProcess calls. Returns one tree per task plus the chore's own params per task.",
    {
      choreName: z.string().describe("Chore name (case-insensitive)"),
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
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact param values whose name matches /pass|pwd|secret|token|key|credential|auth/i to '***'. Includes chore-task params, edge params, env, and snippet. Default: true.",
        ),
    },
    async ({ choreName, includeSystem, includeControl, maskSecrets }) => {
      const index = await buildIndexFromTM1(tm1Client, { includeControl });
      const graph = buildChoreGraph(index, choreName, { includeSystem });
      if (!graph) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                warning: `Chore "${choreName}" not found.`,
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
                maskSecrets,
                tasks: graph.tasks.map((t) => ({
                  step: t.step,
                  processName: t.processName,
                  choreParams: maskSecrets
                    ? maskChoreParams(t.choreParams as unknown as Record<string, unknown>[])
                    : t.choreParams,
                  tree: serializeNode(t.tree, maskSecrets),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
