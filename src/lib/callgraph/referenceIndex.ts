import { KNOWN_SIGNATURES } from './tiSignatures.js';
import { extractDbCalls, extractBracketRefs, parseBracketDimRefs, validateBracketRefSyntax } from './rulesLinter.js';
import { joinContinuationLines } from './tiParser.js';
import { buildProcessEnv, resolveExpression, type ProcessEnv, type VarBinding } from './variableEnv.js';
import { rethrowIfSystemic } from '../../tm1-client/services/fallback.js';

// ─── Argument-Index Auto-Derivation ──────────────────────────────────────────

type ArgIdxMap = Map<string, number>;

function buildArgIdxMap(paramName: string): ArgIdxMap {
  const map: ArgIdxMap = new Map();
  for (const [key, sig] of KNOWN_SIGNATURES.entries()) {
    for (let i = 0; i < sig.params.length; i++) {
      if (sig.params[i]!.name.toLowerCase() === paramName && !map.has(key)) {
        map.set(key, i);
        break;
      }
    }
  }
  return map;
}

const CUBE_ARG_IDX    = buildArgIdxMap('cubename');
const DIM_ARG_IDX     = buildArgIdxMap('dimensionname');
const PROCESS_ARG_IDX = buildArgIdxMap('processname');
const ELEM_ARG_IDX    = buildArgIdxMap('elementname');

/** Subset-membership calls whose ElementName arg is a real element-data-flow reference. */
const SUBSET_ELEM_FUNCS = new Set(['subsetelementinsert', 'subsetelementadd', 'subsetelementdelete']);

const TRACKED_FUNCS = [...new Set([
  ...CUBE_ARG_IDX.keys(),
  ...DIM_ARG_IDX.keys(),
  ...PROCESS_ARG_IDX.keys(),
])];
const FUNC_RE = new RegExp(`\\b(${TRACKED_FUNCS.join('|')})\\s*\\(`, 'gi');

const SKIP_VALIDATION_FUNCS = new Set([
  'dimensioncreate',
  'cubecreate',
  'hierarchycreate',
  'subsetcreate',
  'subsetcreatebymdx',
  'viewcreate',
  'viewcreatebymdx',
]);

// ─── Types ───────────────────────────────────────────────────────────────────

export type RefTargetKind = 'cube' | 'dimension' | 'process' | 'element';
export type RefSourceKind = 'process' | 'rule';
export type RefSection    = 'prolog' | 'metadata' | 'data' | 'epilog' | 'rules' | 'feeders';

/**
 * How a value argument in an ExecuteProcess/RunProcess call-site resolves
 * based on the caller's code (literals + local var tracking, no chain resolution).
 */
export type CallParamResolution =
  | { kind: 'literal'; value: string }                 // literal or local var whose single assignment is a literal
  | { kind: 'passthrough'; paramName: string }         // value comes from a caller-process parameter
  | { kind: 'dynamic' };                               // cannot resolve (function call, concat, loop, CellGet, …)

/**
 * One param pair (name + value) in an ExecuteProcess/RunProcess call.
 * `valueRaw` is the original argument text for display/debugging.
 */
export interface CallParam {
  name: string;
  resolution: CallParamResolution;
  valueRaw: string;
}

export interface TmReference {
  sourceKind: RefSourceKind;           // Where the reference was found
  sourceName: string;                   // Process name or cube name (owner of rules)
  section: RefSection;
  line: number;                         // 0-based within section text
  snippet: string;                      // Trimmed source line (≤200 chars)
  funcName?: string | undefined;        // e.g. CellGetN, DB, ExecuteProcess
  targetKind: RefTargetKind;
  targetName: string;
  /** Only set for ExecuteProcess/RunProcess references (targetKind = 'process'). */
  params?: CallParam[] | undefined;
  /** Owning dimension — only set when targetKind === 'element'. */
  dimension?: string | undefined;
}

/** One task inside a chore: the scheduled process plus its fixed call-site params. */
export interface ChoreTaskRef {
  step: number;                        // 0-based order
  processName: string;                 // original casing
  params: Array<{ name: string; value: string; type: 'string' | 'numeric' }>;
}

/** An ExecuteProcess/RunProcess call-site whose target could not be resolved to a literal process name. */
export interface UnresolvedCall {
  section: RefSection;                 // prolog | metadata | data | epilog
  line: number;                        // 0-based within section text
  funcName: string;                    // ExecuteProcess | RunProcess
  expr: string;                        // raw target-arg text, e.g. "sDyn" or "'te'|'st'"
  snippet: string;                     // trimmed source line
  reason: 'dynamic' | 'param';         // param = callee target is itself a process parameter
}

/** A subset-membership element arg (SubsetElementInsert/Add/Delete) whose element name could not be resolved to a literal. */
export interface UnresolvedElementRef {
  section: RefSection;
  line: number;
  funcName: string;                    // SubsetElementInsert | SubsetElementAdd | SubsetElementDelete
  dimension?: string | undefined;      // may still resolve even when the element does not
  expr: string;                        // raw element-arg text, e.g. "sElem" or "CellGetS(...)"
  snippet: string;
  reason: 'dynamic' | 'param';
}

export interface ReferenceIndex {
  all: TmReference[];
  byCube:    Map<string, TmReference[]>;
  byDim:     Map<string, TmReference[]>;
  byProcess: Map<string, TmReference[]>;
  /** Process name (lowercased) → refs originating FROM that process (for call-graph downstream traversal). */
  bySourceProcess: Map<string, TmReference[]>;
  /** Process name (lowercased) → unresolved ExecuteProcess/RunProcess call sites (dynamic/param target). */
  unresolvedCallsBySourceProcess: Map<string, UnresolvedCall[]>;
  /** elementKey(dim, element) → element references (subset-membership calls). */
  byElement: Map<string, TmReference[]>;
  /** Process name (lowercased) → element args that could not be resolved to a literal. */
  unresolvedElementRefsBySourceProcess: Map<string, UnresolvedElementRef[]>;
  /** Process name (lowercased) → declared param names (original casing). */
  processParams: Map<string, string[]>;
  /** Process name (lowercased) → param-name → default value (string form), for root-env seeding. */
  processDefaults: Map<string, Map<string, string>>;
  /** Chore name (lowercased) → ordered task list. */
  choreTasks: Map<string, ChoreTaskRef[]>;
}

// ─── Helpers (subset of rulesLinter/tiServerLinter internals) ────────────────

function neutralizeLine(line: string): string {
  return line
    .replace(/'[^']*'/g, s => ' '.repeat(s.length))
    .replace(/#.*$/, '');
}

export function splitArgs(argsStr: string): string[] {
  if (!argsStr.trim()) { return []; }
  const args: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = '';
  for (const ch of argsStr) {
    if (ch === "'" && !inStr)      { inStr = true;  cur += ch; }
    else if (ch === "'" && inStr)  { inStr = false; cur += ch; }
    else if (!inStr && ch === '(') { depth++; cur += ch; }
    else if (!inStr && ch === ')') { depth--; cur += ch; }
    else if (!inStr && depth === 0 && ch === ',') { args.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  args.push(cur.trim());
  return args.filter(a => a !== '');
}

/** Composite key for the byElement index: dimension + element, both lowercased. */
export function elementKey(dimension: string, element: string): string {
  return `${dimension.toLowerCase()} ${element.toLowerCase()}`;
}

function extractStringLiteral(arg: string): string | null {
  const t = arg.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 3) {
    const inner = t.slice(1, -1);
    if (!inner.includes("'")) { return inner; }
  }
  return null;
}

const SECTION_MARKER_RE = /^57[2345],\d*$/;

function truncateSnippet(line: string): string {
  const t = line.trim();
  return t.length > 200 ? t.slice(0, 197) + '…' : t;
}

// ─── TI reference extraction (one section at a time) ─────────────────────────

interface RawTiRef {
  line: number;
  funcName: string;
  targetKind: RefTargetKind;
  targetName: string;
  snippet: string;
  params?: CallParam[] | undefined;
  dimension?: string | undefined;   // set for element refs (owning dimension)
}

interface RawUnresolvedCall {
  line: number;
  funcName: string;
  expr: string;
  snippet: string;
  reason: 'dynamic' | 'param';
}

/** A subset-membership element arg that could not be resolved to a literal (raw, pre-section). */
interface RawUnresolvedElementRef {
  line: number;
  funcName: string;
  dimension?: string | undefined;
  expr: string;
  snippet: string;
  reason: 'dynamic' | 'param';
}

/**
 * Resolve a single value-arg of an ExecuteProcess param-value pair.
 * Uses the caller's ProcessEnv to resolve bare variables to literals or
 * caller-param references.
 */
function resolveValueArg(arg: string, env: ProcessEnv): { resolution: CallParamResolution; valueRaw: string } {
  const valueRaw = arg.trim();
  const binding: VarBinding = resolveExpression(valueRaw, env);
  if (binding.kind === 'literal')    { return { resolution: { kind: 'literal',     value: binding.value }, valueRaw }; }
  if (binding.kind === 'param')      { return { resolution: { kind: 'passthrough', paramName: binding.paramName }, valueRaw }; }
  return { resolution: { kind: 'dynamic' }, valueRaw };
}

/**
 * For ExecuteProcess/RunProcess: parse param pairs starting at arg index 1.
 * Dangling single args (odd count) and pairs with a dynamic param-name arg
 * are skipped.
 */
function extractCallParams(args: string[], env: ProcessEnv): CallParam[] {
  const params: CallParam[] = [];
  for (let i = 1; i + 1 < args.length; i += 2) {
    const nameLit = extractStringLiteral(args[i]!);
    if (nameLit === null) { continue; }
    const { resolution, valueRaw } = resolveValueArg(args[i + 1]!, env);
    params.push({ name: nameLit, resolution, valueRaw });
  }
  return params;
}

const PROCESS_CALL_FUNCS = new Set(['executeprocess', 'runprocess']);

/**
 * Extracts cube/dimension/process references from a single TI text (one section).
 * Pure function — no network, no vscode.
 *
 * @param text       TI source (prolog/metadata/data/epilog)
 * @param env        Process environment for variable resolution in ExecuteProcess args.
 *                   Defaults to an empty env (no param refs, no local vars) if omitted.
 */
export function extractTiReferences(
  text: string,
  env?: ProcessEnv,
  sharedLiveVars?: Map<string, VarBinding>,
  unresolvedOut?: RawUnresolvedCall[],
  unresolvedElemOut?: RawUnresolvedElementRef[],
): RawTiRef[] {
  const baseEnv: ProcessEnv = env ?? {
    paramsLc: new Set(),
    paramOriginal: new Map(),
    paramTypes: new Map(),
    datasourceVars: new Map(),
    vars: new Map(),
  };
  // Flow-sensitive Var-Tracking: Basis-Env (Params/DS-Vars/cross-section-Vars) + live
  // aktualisierte lokale Vars. Jede Zuweisung überschreibt (last-assignment-wins), so dass
  // Orchestrator-Muster wie `sProc='A'; RUNPROCESS(sProc,…); sProc='B'; RUNPROCESS(sProc,…);`
  // beide Calls als eigene Refs auflösen statt auf `dynamic` zu demovieren.
  // sharedLiveVars wird über Sections hinweg durchgereicht (Prolog-Zuweisung sichtbar in Data/Epilog).
  const liveVars = sharedLiveVars ?? new Map(baseEnv.vars);
  const callerEnv: ProcessEnv = { ...baseEnv, vars: liveVars };
  const refs: RawTiRef[] = [];
  // Multi-line-Calls auf ihre Startzeile zusammenfassen — Continuation-Zeilen werden leer.
  const lines = joinContinuationLines(text.split('\n').map(l => l.replace(/\r$/, '')));

  const assignRe = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?\s*(?:#.*)?$/;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    if (SECTION_MARKER_RE.test(line.trim()) || line.trim() === '') { continue; }

    const neutralized = neutralizeLine(line);
    if (neutralized.trim() === '') { continue; }

    // Vor der Call-Erkennung: Zuweisungen in liveVars eintragen (last-assignment-wins).
    const aM = assignRe.exec(line);
    if (aM && !aM[2]!.startsWith('=')) {
      const varLc = aM[1]!.toLowerCase();
      if (!baseEnv.paramsLc.has(varLc) && !baseEnv.datasourceVars.has(varLc)) {
        liveVars.set(varLc, resolveExpression(aM[2]!, callerEnv));
      }
    }

    FUNC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FUNC_RE.exec(neutralized)) !== null) {
      const funcLower = m[1]!.toLowerCase();
      const openParen = m.index + m[0].length - 1;

      let depth = 1;
      let i = openParen + 1;
      while (i < neutralized.length && depth > 0) {
        if (neutralized[i] === '(')      { depth++; }
        else if (neutralized[i] === ')') { depth--; }
        i++;
      }
      if (depth !== 0) { continue; }

      const argsStr = line.slice(openParen + 1, i - 1);
      const args = splitArgs(argsStr);

      if (SKIP_VALIDATION_FUNCS.has(funcLower)) { continue; }

      const snippet = truncateSnippet(line);
      const pushRef = (kind: RefTargetKind, argIdx: number | undefined) => {
        if (argIdx === undefined || argIdx >= args.length) { return; }
        const argVal = args[argIdx]!;
        let targetName = extractStringLiteral(argVal);
        if (targetName === null) {
          const binding = resolveExpression(argVal, callerEnv);
          if (binding.kind !== 'literal') {
            // Surface (do not resolve) a process-call target that isn't a literal —
            // it's still a real call edge, just one we can't name statically.
            if (unresolvedOut && kind === 'process' && PROCESS_CALL_FUNCS.has(funcLower)) {
              unresolvedOut.push({
                line: lineIdx,
                funcName: m![1]!,
                expr: argVal.trim(),
                snippet,
                reason: binding.kind === 'param' ? 'param' : 'dynamic',
              });
            }
            return;
          }
          targetName = binding.value;
        }
        const params = kind === 'process' && PROCESS_CALL_FUNCS.has(funcLower)
          ? extractCallParams(args, callerEnv)
          : undefined;
        refs.push({ line: lineIdx, funcName: m![1]!, targetKind: kind, targetName, snippet, params });
      };
      pushRef('cube',      CUBE_ARG_IDX.get(funcLower));
      pushRef('dimension', DIM_ARG_IDX.get(funcLower));
      pushRef('process',   PROCESS_ARG_IDX.get(funcLower));

      // Element refs need BOTH the element name and its owning dimension resolved
      // together, so use a dedicated block instead of the single-arg pushRef.
      if (SUBSET_ELEM_FUNCS.has(funcLower)) {
        const elemIdx = ELEM_ARG_IDX.get(funcLower);
        const dimIdx = DIM_ARG_IDX.get(funcLower);
        if (elemIdx !== undefined && elemIdx < args.length) {
          const elemArg = args[elemIdx]!;
          // Resolve the owning dimension (literal or var); undefined if unresolvable.
          let dimName: string | undefined;
          if (dimIdx !== undefined && dimIdx < args.length) {
            const dimArg = args[dimIdx]!;
            dimName = extractStringLiteral(dimArg) ?? undefined;
            if (dimName === undefined) {
              const db = resolveExpression(dimArg, callerEnv);
              if (db.kind === 'literal') { dimName = db.value; }
            }
          }
          let elemName = extractStringLiteral(elemArg);
          if (elemName === null) {
            const eb = resolveExpression(elemArg, callerEnv);
            if (eb.kind === 'literal') {
              elemName = eb.value;
            } else {
              if (unresolvedElemOut) {
                unresolvedElemOut.push({
                  line: lineIdx,
                  funcName: m[1]!,
                  dimension: dimName,
                  expr: elemArg.trim(),
                  snippet,
                  reason: eb.kind === 'param' ? 'param' : 'dynamic',
                });
              }
              elemName = null;
            }
          }
          if (elemName !== null) {
            refs.push({ line: lineIdx, funcName: m[1]!, targetKind: 'element', targetName: elemName, dimension: dimName, snippet, params: undefined });
          }
        }
      }
    }
  }
  return refs;
}

// ─── Rules reference extraction ──────────────────────────────────────────────

interface RawRuleRef {
  line: number;
  section: 'rules' | 'feeders';
  funcName?: string | undefined;
  targetKind: 'cube' | 'dimension';
  targetName: string;
  snippet: string;
}

const FEEDERS_MARKER_RE = /^\s*FEEDERS\s*;/i;

/**
 * Extracts cube (from DB()) and dimension (from [...] refs) references
 * from a rules/feeders text. Pure function.
 */
export function extractRulesReferences(text: string): RawRuleRef[] {
  const refs: RawRuleRef[] = [];
  const lines = text.split('\n');
  let section: 'rules' | 'feeders' = 'rules';

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!.replace(/\r$/, '');
    const trimmed = line.trim();
    if (FEEDERS_MARKER_RE.test(trimmed)) { section = 'feeders'; continue; }
    if (trimmed === '' || trimmed.startsWith('#')) { continue; }

    const snippet = truncateSnippet(line);

    // DB(...) → cube reference
    for (const call of extractDbCalls(line)) {
      if (call.cubeName !== null) {
        refs.push({ line: lineIdx, section, funcName: 'DB', targetKind: 'cube', targetName: call.cubeName, snippet });
      }
    }

    // [...] → dimension references (only valid syntactic refs)
    for (const bracket of extractBracketRefs(line)) {
      if (validateBracketRefSyntax(bracket) !== null) { continue; }
      if (!bracket.includes("'")) { continue; }
      for (const { dim } of parseBracketDimRefs(bracket)) {
        refs.push({ line: lineIdx, section, targetKind: 'dimension', targetName: dim, snippet });
      }
    }
  }
  return refs;
}

// ─── Index assembly ──────────────────────────────────────────────────────────

export interface ProcessFetchResult {
  name: string;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
  /** Parameter names declared on this process (used for pass-through resolution). */
  parameters?: string[];
  /** Default values (string form) by param name, if known. Used as root-env when graph starts here. */
  parameterDefaults?: Map<string, string>;
}

export interface CubeRulesFetchResult {
  cubeName: string;
  rulesText: string;   // full rules incl. FEEDERS section
}

export interface ChoreFetchResult {
  name: string;
  tasks: ChoreTaskRef[];
}

export interface BuildIndexDeps {
  fetchProcesses: () => Promise<ProcessFetchResult[]>;
  fetchCubesWithRules: () => Promise<CubeRulesFetchResult[]>;
  fetchChores?: () => Promise<ChoreFetchResult[]>;
}

/**
 * Builds a complete reference index from processes + cube rules.
 * Pure function — dependencies are injected to allow testing without network.
 */
export async function buildReferenceIndex(deps: BuildIndexDeps): Promise<ReferenceIndex> {
  // Per-source tolerance: a NOT_FOUND / PERMISSION_DENIED on one domain
  // degrades to an empty slice. But a systemic failure (auth expired, server
  // unreachable, lock timeout) must propagate — otherwise an outage builds an
  // empty index that looks like an empty server and gets cached as truth.
  const [processes, cubes, chores] = await Promise.all([
    deps.fetchProcesses().catch((e) => {
      rethrowIfSystemic(e);
      return [] as ProcessFetchResult[];
    }),
    deps.fetchCubesWithRules().catch((e) => {
      rethrowIfSystemic(e);
      return [] as CubeRulesFetchResult[];
    }),
    deps.fetchChores?.().catch((e) => {
      rethrowIfSystemic(e);
      return [] as ChoreFetchResult[];
    }) ?? Promise.resolve([] as ChoreFetchResult[]),
  ]);

  const all: TmReference[] = [];
  const unresolvedCallsBySourceProcess = new Map<string, UnresolvedCall[]>();
  const unresolvedElementRefsBySourceProcess = new Map<string, UnresolvedElementRef[]>();

  const pushTi = (
    sourceName: string,
    section: RefSection,
    text: string,
    env: ProcessEnv,
    sharedLiveVars: Map<string, VarBinding>,
  ) => {
    if (!text) { return; }
    const unresolvedOut: RawUnresolvedCall[] = [];
    const unresolvedElemOut: RawUnresolvedElementRef[] = [];
    for (const r of extractTiReferences(text, env, sharedLiveVars, unresolvedOut, unresolvedElemOut)) {
      all.push({
        sourceKind: 'process',
        sourceName,
        section,
        line: r.line,
        snippet: r.snippet,
        funcName: r.funcName,
        targetKind: r.targetKind,
        targetName: r.targetName,
        dimension: r.dimension,          // ← forward element owner
        params: r.params,
      });
    }
    if (unresolvedOut.length > 0) {
      const key = sourceName.toLowerCase();
      const bucket = unresolvedCallsBySourceProcess.get(key) ?? [];
      for (const u of unresolvedOut) {
        bucket.push({ section, line: u.line, funcName: u.funcName, expr: u.expr, snippet: u.snippet, reason: u.reason });
      }
      unresolvedCallsBySourceProcess.set(key, bucket);
    }
    if (unresolvedElemOut.length > 0) {
      const key = sourceName.toLowerCase();
      const arr = unresolvedElementRefsBySourceProcess.get(key) ?? [];
      for (const u of unresolvedElemOut) {
        arr.push({ section, line: u.line, funcName: u.funcName, dimension: u.dimension, expr: u.expr, snippet: u.snippet, reason: u.reason });
      }
      unresolvedElementRefsBySourceProcess.set(key, arr);
    }
  };

  for (const p of processes) {
    // Build env once from *all* sections concatenated so var assignments made in
    // Prolog are visible to ExecuteProcess calls in Data/Epilog (mirrors TI runtime behavior).
    const combinedText = [p.prolog, p.metadata, p.data, p.epilog].join('\n');
    const env = buildProcessEnv(combinedText, p.parameters ?? []);
    // Shared liveVars über alle 4 Sections — Prolog-Zuweisungen bleiben in Data/Epilog sichtbar
    // und die flow-sensitive Auswertung funktioniert auch über Section-Grenzen hinweg.
    const sharedLiveVars = new Map(env.vars);

    pushTi(p.name, 'prolog',   p.prolog,   env, sharedLiveVars);
    pushTi(p.name, 'metadata', p.metadata, env, sharedLiveVars);
    pushTi(p.name, 'data',     p.data,     env, sharedLiveVars);
    pushTi(p.name, 'epilog',   p.epilog,   env, sharedLiveVars);
  }

  for (const c of cubes) {
    if (!c.rulesText) { continue; }
    for (const r of extractRulesReferences(c.rulesText)) {
      all.push({
        sourceKind: 'rule',
        sourceName: c.cubeName,
        section: r.section,
        line: r.line,
        snippet: r.snippet,
        funcName: r.funcName,
        targetKind: r.targetKind,
        targetName: r.targetName,
      });
    }
  }

  const byCube          = new Map<string, TmReference[]>();
  const byDim           = new Map<string, TmReference[]>();
  const byProcess       = new Map<string, TmReference[]>();
  const byElement       = new Map<string, TmReference[]>();
  const bySourceProcess = new Map<string, TmReference[]>();

  const bucket = (m: Map<string, TmReference[]>, key: string, ref: TmReference) => {
    const lc = key.toLowerCase();
    const arr = m.get(lc) ?? [];
    arr.push(ref);
    m.set(lc, arr);
  };

  for (const ref of all) {
    switch (ref.targetKind) {
      case 'cube':      bucket(byCube,    ref.targetName, ref); break;
      case 'dimension': bucket(byDim,     ref.targetName, ref); break;
      case 'process':   bucket(byProcess, ref.targetName, ref); break;
      case 'element':
        if (ref.dimension) {
          const k = elementKey(ref.dimension, ref.targetName);
          const arr = byElement.get(k) ?? [];
          arr.push(ref);
          byElement.set(k, arr);
        }
        break;
    }
    if (ref.sourceKind === 'process') {
      bucket(bySourceProcess, ref.sourceName, ref);
    }
  }

  const processParams = new Map<string, string[]>();
  const processDefaults = new Map<string, Map<string, string>>();
  for (const p of processes) {
    if (p.parameters && p.parameters.length > 0) {
      processParams.set(p.name.toLowerCase(), p.parameters);
    }
    if (p.parameterDefaults && p.parameterDefaults.size > 0) {
      processDefaults.set(p.name.toLowerCase(), p.parameterDefaults);
    }
  }

  const choreTasks = new Map<string, ChoreTaskRef[]>();
  for (const c of chores) {
    if (!c.name) { continue; }
    choreTasks.set(c.name.toLowerCase(), c.tasks);
  }

  return {
    all,
    byCube,
    byDim,
    byProcess,
    byElement,
    bySourceProcess,
    unresolvedCallsBySourceProcess,
    unresolvedElementRefsBySourceProcess,
    processParams,
    processDefaults,
    choreTasks,
  };
}

/** Convenience lookup — returns [] if target is not indexed. */
export function lookupReferences(
  idx: ReferenceIndex,
  targetKind: RefTargetKind,
  targetName: string,
): TmReference[] {
  const lc = targetName.toLowerCase();
  switch (targetKind) {
    case 'cube':      return idx.byCube.get(lc)    ?? [];
    case 'dimension': return idx.byDim.get(lc)     ?? [];
    case 'process':   return idx.byProcess.get(lc) ?? [];
    // byElement is keyed by elementKey(dim, element), a composite key this single-name
    // lookup can't build — callers needing element refs use idx.byElement directly.
    case 'element':   return [];
  }
}
