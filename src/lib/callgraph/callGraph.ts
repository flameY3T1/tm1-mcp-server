import type { ReferenceIndex, TmReference, CallParam, CallParamResolution, UnresolvedCall } from './referenceIndex.js';
import { lookupReferences } from './referenceIndex.js';

/**
 * Effective parameter value in the context of a specific graph node.
 * - literal: fully resolved value (from explicit literal, propagated literal, or process default)
 * - unknown: value would need to flow in from an upstream param we cannot see (root input)
 *            `viaParam` is the name of the originating root-level param (for display: pX=«pX»)
 * - dynamic: resolution is known to be impossible (CellGet, concat, IF, loops, …)
 */
export type EffectiveValue =
  | { kind: 'literal'; value: string }
  | { kind: 'unknown'; viaParam: string }
  | { kind: 'dynamic' };

/**
 * One edge in the call graph = one ExecuteProcess/RunProcess call site.
 * Each call site has its own params (same caller→callee pair can appear
 * multiple times with different params).
 */
export interface CallEdge {
  caller: string;
  callee: string;
  section: string;                      // prolog/metadata/data/epilog
  line: number;                         // 0-based within section
  funcName: string;                     // ExecuteProcess / RunProcess
  snippet: string;
  params: CallParam[];
  /**
   * Effective value per call-param at THIS edge (parent env applied).
   * Only populated for downstream direction. Index matches `params`.
   */
  effectiveParams?: Array<{ name: string; effective: EffectiveValue; valueRaw: string }>;
}

/**
 * A node in the call graph tree. Parent→child edge is described by `incomingEdge`
 * (the call that reached this node). The root node has incomingEdge = null.
 */
export interface CallGraphNode {
  process: string;
  incomingEdge: CallEdge | null;
  /**
   * Effective parameter environment AT this node (after call-site resolution).
   * Keys are lowercased param names. Only populated for downstream direction.
   */
  env?: Map<string, EffectiveValue> | undefined;
  children: CallGraphNode[];
  cycle: boolean;
  depthLimitReached?: boolean | undefined;
  /** Outgoing calls target could not statically resolved (downstream only). */
  unresolvedCalls?: UnresolvedCall[] | undefined;
}

export type Direction = 'downstream' | 'upstream';

export interface BuildCallGraphOptions {
  direction: Direction;
  maxDepth?: number;                    // default 20, hard safety cap
  /**
   * Include system objects (names starting with `}`) as children/ancestors.
   * The root node is always shown regardless of this flag.
   * Default: true.
   */
  includeSystem?: boolean;
}

function lc(s: string): string { return s.toLowerCase(); }

/** Build outgoing call edges for a given process (what it calls). */
function outgoingCalls(index: ReferenceIndex, process: string): CallEdge[] {
  const refs = index.bySourceProcess.get(lc(process)) ?? [];
  const edges: CallEdge[] = [];
  for (const r of refs) {
    if (r.targetKind !== 'process') { continue; }
    if (!r.funcName) { continue; }
    edges.push(refToEdge(r));
  }
  return edges;
}

/** Build incoming call edges (callers of this process). */
function incomingCalls(index: ReferenceIndex, process: string): CallEdge[] {
  const refs = index.byProcess.get(lc(process)) ?? [];
  const edges: CallEdge[] = [];
  for (const r of refs) {
    if (r.sourceKind !== 'process') { continue; }
    if (!r.funcName) { continue; }
    edges.push(refToEdge(r));
  }
  return edges;
}

function refToEdge(r: TmReference): CallEdge {
  return {
    caller:   r.sourceName,
    callee:   r.targetName,
    section:  r.section,
    line:     r.line,
    funcName: r.funcName ?? 'ExecuteProcess',
    snippet:  r.snippet,
    params:   r.params ?? [],
  };
}

// ─── Env resolution ──────────────────────────────────────────────────────────

/**
 * Resolve one call-site CallParamResolution against the parent node's env.
 * - literal stays literal
 * - passthrough → look up the named caller-param in parent env:
 *     known literal → propagate; unknown → mark unknown; dynamic → dynamic
 * - dynamic stays dynamic
 */
export function resolveEdgeParam(
  res: CallParamResolution,
  parentEnv: Map<string, EffectiveValue>,
): EffectiveValue {
  switch (res.kind) {
    case 'literal': return { kind: 'literal', value: res.value };
    case 'dynamic': return { kind: 'dynamic' };
    case 'passthrough': {
      const up = parentEnv.get(res.paramName.toLowerCase());
      if (!up)                        { return { kind: 'unknown', viaParam: res.paramName }; }
      if (up.kind === 'literal')      { return up; }
      if (up.kind === 'unknown')      { return { kind: 'unknown', viaParam: up.viaParam }; }
      return { kind: 'dynamic' };
    }
  }
}

/** Initial env for a process: its declared params, filled with defaults if known, else unknown. */
function buildInitialEnv(procName: string, index: ReferenceIndex): Map<string, EffectiveValue> {
  const env = new Map<string, EffectiveValue>();
  const params = index.processParams.get(lc(procName)) ?? [];
  const defaults = index.processDefaults.get(lc(procName));
  for (const p of params) {
    const def = defaults?.get(p);
    env.set(lc(p), def !== undefined ? { kind: 'literal', value: def } : { kind: 'unknown', viaParam: p });
  }
  return env;
}

/**
 * Derive child's env from parent's env + edge params.
 * Start from child's initial env (its own params + defaults), then overwrite
 * anything the caller passed explicitly at this call site.
 */
function deriveChildEnv(
  childProc: string,
  edge: CallEdge,
  parentEnv: Map<string, EffectiveValue>,
  index: ReferenceIndex,
): Map<string, EffectiveValue> {
  const env = buildInitialEnv(childProc, index);
  const effectiveParams: NonNullable<CallEdge['effectiveParams']> = [];
  for (const cp of edge.params) {
    const eff = resolveEdgeParam(cp.resolution, parentEnv);
    env.set(lc(cp.name), eff);
    effectiveParams.push({ name: cp.name, effective: eff, valueRaw: cp.valueRaw });
  }
  edge.effectiveParams = effectiveParams;
  return env;
}

function unresolvedFor(
  index: ReferenceIndex,
  process: string,
  direction: Direction,
): UnresolvedCall[] | undefined {
  if (direction !== 'downstream') { return undefined; }
  const u = index.unresolvedCallsBySourceProcess.get(lc(process));
  return u && u.length > 0 ? u : undefined;
}

// ─── Graph construction ─────────────────────────────────────────────────────

/**
 * Recursively build the call graph starting from `start`.
 *
 * downstream: children = processes that THIS process calls (with env-propagation)
 * upstream:   children = processes that CALL this process (no env-propagation)
 *
 * Cycle detection uses the ancestor chain: if a candidate child is already
 * on the path from the root, `cycle = true` and children are empty.
 *
 * Duplicate edges (same caller→callee, different lines/sections) are kept
 * as separate nodes — each represents a distinct call site.
 */
export function buildCallGraph(
  index: ReferenceIndex,
  start: string,
  opts: BuildCallGraphOptions,
): CallGraphNode {
  const maxDepth = opts.maxDepth ?? 20;
  const includeSystem = opts.includeSystem ?? true;
  const rootEnv = opts.direction === 'downstream' ? buildInitialEnv(start, index) : undefined;
  const root: CallGraphNode = {
    process: start,
    incomingEdge: null,
    env: rootEnv,
    children: [],
    cycle: false,
    unresolvedCalls: unresolvedFor(index, start, opts.direction),
  };

  const visit = (node: CallGraphNode, ancestors: Set<string>, depth: number) => {
    if (depth >= maxDepth) {
      node.depthLimitReached = true;
      return;
    }
    const edges = opts.direction === 'downstream'
      ? outgoingCalls(index, node.process)
      : incomingCalls(index, node.process);

    edges.sort((a, b) =>
      (opts.direction === 'downstream'
        ? a.callee.localeCompare(b.callee)
        : a.caller.localeCompare(b.caller))
      || a.line - b.line,
    );

    for (const edge of edges) {
      const nextProc = opts.direction === 'downstream' ? edge.callee : edge.caller;
      if (!includeSystem && nextProc.startsWith('}')) { continue; }
      const childEnv = opts.direction === 'downstream' && node.env
        ? deriveChildEnv(nextProc, edge, node.env, index)
        : undefined;
      const childNode: CallGraphNode = {
        process: nextProc,
        incomingEdge: edge,
        env: childEnv,
        children: [],
        cycle: ancestors.has(lc(nextProc)),
        unresolvedCalls: unresolvedFor(index, nextProc, opts.direction),
      };
      node.children.push(childNode);
      if (!childNode.cycle) {
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(lc(nextProc));
        visit(childNode, nextAncestors, depth + 1);
      }
    }
  };

  const initialAncestors = new Set<string>([lc(start)]);
  visit(root, initialAncestors, 0);
  return root;
}

// ─── Cube / Dimension usage ─────────────────────────────────────────────────

// Functions that write cell/attribute data into a cube.
const WRITE_FUNCS = new Set([
  'cellputn', 'cellputs', 'cellincrementn',
  'batchcellincrement', 'cellputproportionalspread',
  'viewzeroout', 'cubecleardata', 'cubeprocessfeeders',
  // Cube attribute value writes (target the }CubeAttributes control cube).
  'cubeattrputn', 'cubeattrputs',
  // Element/dimension attribute value writes (target the }ElementAttributes_<dim>
  // control cube; classified as a write on the dimension).
  'attrputn', 'attrputs', 'elementattrputn', 'elementattrputs',
]);

// Functions that read cell/attribute data from a cube.
const READ_FUNCS = new Set([
  'cellgetn', 'cellgets', 'cellexists', 'cellisrule', 'cellisundefined', 'cellisupdateable',
  // Cube attribute value reads (locale form; CubeAttrN/S base form is not a real TI fn).
  'cubeattrnl', 'cubeattrsl',
  // Element/dimension attribute value reads (classified as a read on the dimension).
  'attrn', 'attrs', 'attrnl', 'attrsl',
  'elementattrn', 'elementattrs', 'elementattrnl', 'elementattrsl',
  'db', // cube rule DB() reference
]);

export function classifyAccess(funcName: string | undefined, sourceKind: 'process' | 'rule'): 'read' | 'write' | 'other' {
  // Rule bracket-refs and DB() are always reads.
  if (sourceKind === 'rule') return 'read';
  if (!funcName) return 'other';
  const lc = funcName.toLowerCase();
  if (WRITE_FUNCS.has(lc)) return 'write';
  if (READ_FUNCS.has(lc)) return 'read';
  return 'other';
}

/** Flat usage reference — one occurrence where a cube/dimension is referenced. */
export interface UsageRef {
  sourceKind: 'process' | 'rule';
  sourceName: string;
  section: string;
  line: number;
  funcName?: string | undefined;
  snippet: string;
  /** Classified access type: 'read' (CellGetN/S, DB), 'write' (CellPutN/S, ViewZeroOut, …), 'other' (structural). */
  accessType: 'read' | 'write' | 'other';
}

/**
 * Collect all references to a cube or dimension as a flat list, sorted by
 * source name and line. Self-references (a cube's own rules reading from the
 * cube itself via DB()/`[...]`) are filtered out to avoid noise — the rule
 * editor already shows them inline.
 */
export function buildCubeOrDimUsages(
  index: ReferenceIndex,
  kind: 'cube' | 'dimension',
  name: string,
  opts: { includeSystem?: boolean; accessMode?: 'read' | 'write' | 'all' } = {},
): UsageRef[] {
  const includeSystem = opts.includeSystem ?? true;
  const accessMode = opts.accessMode ?? 'all';
  const refs = lookupReferences(index, kind, name);
  const result: UsageRef[] = [];
  const nameLc = name.toLowerCase();
  for (const r of refs) {
    // Skip self-refs: a cube's own rules referencing itself via DB()/`[...]`
    if (kind === 'cube' && r.sourceKind === 'rule' && r.sourceName.toLowerCase() === nameLc) {
      continue;
    }
    if (!includeSystem && r.sourceName.startsWith('}')) { continue; }
    const accessType = classifyAccess(r.funcName, r.sourceKind);
    if (accessMode !== 'all' && accessType !== accessMode) { continue; }
    result.push({
      sourceKind: r.sourceKind,
      sourceName: r.sourceName,
      section: r.section,
      line: r.line,
      funcName: r.funcName,
      snippet: r.snippet,
      accessType,
    });
  }
  result.sort((a, b) => a.sourceName.localeCompare(b.sourceName) || a.line - b.line);
  return result;
}

/** Flattens the tree depth-first for simple list rendering. */
export function flattenCallGraph(root: CallGraphNode): Array<{ node: CallGraphNode; depth: number }> {
  const out: Array<{ node: CallGraphNode; depth: number }> = [];
  const walk = (n: CallGraphNode, depth: number) => {
    out.push({ node: n, depth });
    for (const c of n.children) { walk(c, depth + 1); }
  };
  walk(root, 0);
  return out;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatEffective(eff: EffectiveValue, valueRaw: string): string {
  switch (eff.kind) {
    case 'literal': {
      const wasQuoted = valueRaw.trim().startsWith("'");
      return wasQuoted ? `'${eff.value}'` : eff.value;
    }
    case 'unknown': return `«${eff.viaParam}»`;
    case 'dynamic': return '?';
  }
}

/**
 * Human-readable param summary using effective values (env-propagated).
 * Falls back to raw resolution if no effective values are available (upstream mode).
 *   pRegion='UK', pYear=2026, pSource=«pCaller», pDate=?
 */
export function formatEdgeParams(edge: CallEdge): string {
  if (edge.effectiveParams) {
    if (edge.effectiveParams.length === 0) { return ''; }
    return edge.effectiveParams
      .map(ep => `${ep.name}=${formatEffective(ep.effective, ep.valueRaw)}`)
      .join(', ');
  }
  // Upstream (no env): show resolution directly
  if (edge.params.length === 0) { return ''; }
  return edge.params.map(p => {
    switch (p.resolution.kind) {
      case 'literal':     {
        const wasQuoted = p.valueRaw.trim().startsWith("'");
        return wasQuoted ? `${p.name}='${p.resolution.value}'` : `${p.name}=${p.resolution.value}`;
      }
      case 'passthrough': return `${p.name}=«${p.resolution.paramName}»`;
      case 'dynamic':     return `${p.name}=?`;
    }
  }).join(', ');
}
