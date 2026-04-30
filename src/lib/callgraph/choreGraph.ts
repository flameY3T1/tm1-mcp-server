import type { ReferenceIndex, ChoreTaskRef, CallParamResolution } from './referenceIndex.js';
import type { CallGraphNode, EffectiveValue } from './callGraph.js';
import { buildCallGraph } from './callGraph.js';

export interface ChoreTaskTree {
  step: number;
  processName: string;
  choreParams: ChoreTaskRef['params'];
  tree: CallGraphNode;
}

export interface ChoreGraph {
  choreName: string;
  tasks: ChoreTaskTree[];
}

export interface BuildChoreGraphOptions {
  /** Mirrors the call-graph option — filters }-prefixed sub-processes. Default: true. */
  includeSystem?: boolean;
}

/**
 * Build one downstream tree per chore task. Task params are seeded into the
 * task-process's root env as literals and re-propagated down the tree.
 * Returns null if the chore is not indexed.
 */
export function buildChoreGraph(
  index: ReferenceIndex,
  choreName: string,
  opts: BuildChoreGraphOptions = {},
): ChoreGraph | null {
  const tasks = index.choreTasks.get(choreName.toLowerCase());
  if (!tasks) { return null; }

  const includeSystem = opts.includeSystem ?? true;

  const taskTrees: ChoreTaskTree[] = tasks.map(t => {
    const tree = buildCallGraph(index, t.processName, { direction: 'downstream', includeSystem });
    if (tree.env) {
      for (const p of t.params) {
        tree.env.set(p.name.toLowerCase(), { kind: 'literal', value: p.value });
      }
      propagateNewRootEnv(tree, index);
    }
    return {
      step: t.step,
      processName: t.processName,
      choreParams: t.params,
      tree,
    };
  });

  return { choreName, tasks: taskTrees };
}

/**
 * Re-derive `effectiveParams` on each edge below the root after the chore has
 * overwritten the root's env. We can't reuse `buildCallGraph` because we must
 * keep the same tree instance; instead we re-resolve per child.
 */
function propagateNewRootEnv(root: CallGraphNode, index: ReferenceIndex): void {
  const walk = (node: CallGraphNode, env: Map<string, EffectiveValue>) => {
    for (const child of node.children) {
      const edge = child.incomingEdge;
      if (!edge) { continue; }
      const childEnv = buildInitialEnv(child.process, index);
      const effective: NonNullable<typeof edge.effectiveParams> = [];
      for (const cp of edge.params) {
        const eff = resolveEdgeParam(cp.resolution, env);
        childEnv.set(cp.name.toLowerCase(), eff);
        effective.push({ name: cp.name, effective: eff, valueRaw: cp.valueRaw });
      }
      edge.effectiveParams = effective;
      child.env = childEnv;
      if (!child.cycle) { walk(child, childEnv); }
    }
  };
  if (root.env) { walk(root, root.env); }
}

// Local copies of two helpers from callGraph.ts — keeps the module free of
// new exports and preserves the existing public surface. Small and stable.
function buildInitialEnv(procName: string, index: ReferenceIndex): Map<string, EffectiveValue> {
  const env = new Map<string, EffectiveValue>();
  const params = index.processParams.get(procName.toLowerCase()) ?? [];
  const defaults = index.processDefaults.get(procName.toLowerCase());
  for (const p of params) {
    const def = defaults?.get(p);
    env.set(p.toLowerCase(), def !== undefined
      ? { kind: 'literal', value: def }
      : { kind: 'unknown', viaParam: p });
  }
  return env;
}

function resolveEdgeParam(
  res: CallParamResolution,
  parentEnv: Map<string, EffectiveValue>,
): EffectiveValue {
  switch (res.kind) {
    case 'literal': return { kind: 'literal', value: res.value };
    case 'dynamic': return { kind: 'dynamic' };
    case 'passthrough': {
      const up = parentEnv.get(res.paramName.toLowerCase());
      if (!up)                   { return { kind: 'unknown', viaParam: res.paramName }; }
      if (up.kind === 'literal') { return up; }
      if (up.kind === 'unknown') { return { kind: 'unknown', viaParam: up.viaParam }; }
      return { kind: 'dynamic' };
    }
  }
}
