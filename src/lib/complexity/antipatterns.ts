/**
 * TI anti-pattern lint engine.
 *
 * Walks the parsed AST of each process tab and emits a flat list of findings —
 * a different shape from the metrics ranking in {@link ./process-metrics}, kept
 * separate on purpose (rule violations, not a score). The same engine is meant
 * to be reusable later from a single-process pre-commit lint entry point.
 */
import { parseTiCode } from "../callgraph/tiParser.js";
import type {
  TiStatement,
} from "../callgraph/types.js";
import type { ProcessCodeInput, TiTab } from "./process-metrics.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  process: string;
  tab: TiTab;
  line: number;
  rule: string;
  severity: Severity;
  snippet: string;
  hint: string;
}

export interface LintOptions {
  /** Element-arg count at/above which CellGetN/S is flagged as perf-risky. */
  cellGetDimThreshold?: number | undefined;
  /**
   * Additional variable names (case-insensitive) to exclude from dead-assignment
   * detection — pass process parameters and datasource column variable names here.
   */
  excludeVarsFromDeadCheck?: string[] | undefined;
}

const TABS: ReadonlyArray<TiTab> = ["prolog", "metadata", "data", "epilog"];

/**
 * Destructive ops that wipe data/objects. Unconditional use (no enclosing If)
 * is treated as an error — a guard expresses deliberate intent. Lowercased.
 */
const DESTRUCTIVE = new Set<string>([
  "cubecleardata",
  "dimensiondeleteallelements",
  "processdestroy",
]);

/**
 * A destructive op is by-design (not a bug) when the process is a dedicated
 * clear/init/reset/test proc — those exist to wipe data. Matching the name
 * downgrades destructive-unguarded from error to warn (still surfaced, not
 * silenced). Substring match on the lowercased process name.
 */
const CLEAR_PROC_TOKENS = [
  "init",
  "zeroout",
  "zero_out",
  "clear",
  "reset",
  "test",
  "wipe",
];

function isClearProc(name: string): boolean {
  const n = name.toLowerCase();
  return CLEAR_PROC_TOKENS.some((t) => n.includes(t));
}

/** Process-invocation calls; in a loop they recurse/serialize. Lowercased. */
const PROCESS_CALLS = new Set<string>(["executeprocess", "runprocess"]);

const DEFAULT_CELLGET_DIM_THRESHOLD = 12;

// ---- dead-assignment helpers ----

/** TI implicit / datasource variables — never flagged as dead assignments. */
const IMPLICIT_VARS = new Set<string>([
  "value_is_string",
  "nvalue",
  "svalue",
  "datasourcenamescript",
  "datasourceasciidelimiter",
  "datasourceasciiquotecharacter",
  "datasourceasciithousandseparator",
  "datasourceasciiheaderrecords",
  "datasourceasciiDecimalseparator",
  "datasourceasciidecimalseparator",
  "datasourceview",
  "datasourcecube",
  "datasourcedimension",
  "datasourcedimensionsubset",
  "datasourcetype",
  "datasourcenameforserver",
  "datasourcenameforserverisoctet",
]);

function isImplicitVar(name: string): boolean {
  const n = name.toLowerCase();
  if (IMPLICIT_VARS.has(n)) return true;
  // V1, V2, ..., Vn  (datasource column vars)
  if (/^v\d+$/.test(n)) return true;
  return false;
}

/** RHS functions whose capture is idiomatically a return-code — skip dead check on the LHS. */
const SIDE_EFFECT_RHS = new Set<string>([
  "executeprocess",
  "runprocess",
  "fileop",
  "executeview",
]);

function hasSideEffectRhs(expr: string): boolean {
  const lo = expr.toLowerCase();
  for (const fn of SIDE_EFFECT_RHS) {
    if (lo.includes(fn + "(")) return true;
  }
  return false;
}

const IDENTIFIER_RE = /\b([A-Za-z_]\w*)\b/g;
const EXPAND_VAR_RE = /%([A-Za-z_]\w*)%/g;

/** Extract all potential variable-read tokens from a raw TI expression/arg/condition string. */
function collectReads(text: string, out: Set<string>): void {
  // %varName% inside Expand calls
  for (const m of text.matchAll(EXPAND_VAR_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
  // Strip string literals so identifiers inside them don't pollute the read-set
  const stripped = text.replace(/'(?:[^']|'')*'/g, "''");
  for (const m of stripped.matchAll(IDENTIFIER_RE)) {
    if (m[1]) out.add(m[1].toLowerCase());
  }
}

function collectReadsFromStmts(stmts: TiStatement[], out: Set<string>): void {
  for (const s of stmts) {
    if (s.type === "assignment") {
      collectReads(s.expression, out);
    } else if (s.type === "if") {
      const blk = s;
      collectReads(blk.condition, out);
      collectReadsFromStmts(blk.thenBody, out);
      for (const c of blk.elseIfClauses) {
        collectReads(c.condition, out);
        collectReadsFromStmts(c.body, out);
      }
      collectReadsFromStmts(blk.elseBody, out);
    } else if (s.type === "while") {
      const blk = s;
      collectReads(blk.condition, out);
      collectReadsFromStmts(blk.body, out);
    } else if (s.type === "functionCall") {
      for (const arg of s.args) {
        collectReads(arg, out);
      }
    }
  }
}

interface DeadCandidate {
  variable: string;
  originalVar: string;
  tab: TiTab;
  line: number;
}

function collectDeadCandidates(
  stmts: TiStatement[],
  tab: TiTab,
  out: DeadCandidate[],
): void {
  for (const s of stmts) {
    if (s.type === "assignment") {
      if (!isImplicitVar(s.variable) && !hasSideEffectRhs(s.expression)) {
        out.push({
          variable: s.variable.toLowerCase(),
          originalVar: s.variable,
          tab,
          line: s.line,
        });
      }
    } else if (s.type === "if") {
      const blk = s;
      collectDeadCandidates(blk.thenBody, tab, out);
      for (const c of blk.elseIfClauses) {
        collectDeadCandidates(c.body, tab, out);
      }
      collectDeadCandidates(blk.elseBody, tab, out);
    } else if (s.type === "while") {
      const blk = s;
      collectDeadCandidates(blk.body, tab, out);
    }
  }
}

/**
 * Strip a TI single-quoted string literal to its inner value, or return null if
 * the arg is not a string literal (e.g. a variable or number).
 */
function stringLiteralValue(arg: string): string | null {
  const t = arg.trim();
  if (t.length < 2 || t[0] !== "'" || t[t.length - 1] !== "'") return null;
  return t.slice(1, -1).replace(/''/g, "'");
}

/** UNC (`\\srv\…`) or drive-letter (`C:\…`) absolute path. */
const PATH_LITERAL = /^(?:\\\\|[A-Za-z]:[\\/])/;

interface WalkCtx {
  process: string;
  tab: TiTab;
  cellGetDimThreshold: number;
  /** True when the process name marks it a clear/init/reset proc (demotes destructive). */
  clearProc: boolean;
  findings: Finding[];
}

function walk(
  stmts: TiStatement[],
  loopDepth: number,
  ifDepth: number,
  ctx: WalkCtx,
): void {
  for (const s of stmts) {
    if (s.type === "assignment") {
      const cg = s.cellGetInfo;
      if (cg) {
        // params[0] is the cube; remaining args are one element ref per
        // dimension, so dimCount = params.length - 1.
        const dimCount = Math.max(cg.params.length - 1, 0);
        if (dimCount >= ctx.cellGetDimThreshold) {
          const inLoop = loopDepth > 0;
          ctx.findings.push({
            process: ctx.process,
            tab: ctx.tab,
            line: s.line,
            rule: "cellget-perf",
            severity: inLoop ? "warn" : "info",
            snippet: `${s.variable} = ${cg.fn}(${cg.params.join(", ")})`,
            hint:
              `${cg.fn} on a ${dimCount}-dimension cube` +
              (inLoop ? ` inside a loop (depth ${loopDepth})` : "") +
              ` can be a perf hot path on large cubes — worse when many consolidated (C) elements are addressed (not statically detectable here). Consider an MDX/view read or caching.`,
          });
        }
      }
    } else if (s.type === "if") {
      const blk = s;
      walk(blk.thenBody, loopDepth, ifDepth + 1, ctx);
      for (const c of blk.elseIfClauses)
        walk(c.body, loopDepth, ifDepth + 1, ctx);
      walk(blk.elseBody, loopDepth, ifDepth + 1, ctx);
    } else if (s.type === "while") {
      const blk = s;
      walk(blk.body, loopDepth + 1, ifDepth, ctx);
    } else if (s.type === "functionCall") {
      const name = s.name.toLowerCase();
      const snippet = `${s.name}(${s.args.join(", ")})`;
      if (ifDepth === 0 && DESTRUCTIVE.has(name)) {
        ctx.findings.push({
          process: ctx.process,
          tab: ctx.tab,
          line: s.line,
          rule: "destructive-unguarded",
          severity: ctx.clearProc ? "warn" : "error",
          snippet,
          hint: ctx.clearProc
            ? `${s.name} wipes data/objects unconditionally. The process name marks it a clear/init proc, so this is likely by-design — confirm it can only target the intended cube.`
            : `${s.name} wipes data/objects unconditionally — wrap in an If guard so it cannot run by accident.`,
        });
      }
      if (loopDepth > 0 && PROCESS_CALLS.has(name)) {
        const isAsync = name === "runprocess";
        ctx.findings.push({
          process: ctx.process,
          tab: ctx.tab,
          line: s.line,
          rule: "exec-in-loop",
          severity: "warn",
          snippet,
          hint: isAsync
            ? `RunProcess in a loop runs async — you lose control over timing and persistence (when each child commits). Prefer a single child that loops internally.`
            : `ExecuteProcess in a loop runs sync per iteration — adds compounding complexity and overhead. Consider pushing the loop into the child.`,
        });
      }
      for (const arg of s.args) {
        const val = stringLiteralValue(arg);
        if (val && PATH_LITERAL.test(val)) {
          ctx.findings.push({
            process: ctx.process,
            tab: ctx.tab,
            line: s.line,
            rule: "hardcoded-path",
            severity: "warn",
            snippet: `${s.name}(… ${arg} …)`,
            hint: `Hardcoded path '${val}' in ${s.name} — move it to a process parameter or a config cube so it survives environment moves.`,
          });
        }
      }
    }
  }
}

export function lintProcess(
  process: string,
  code: ProcessCodeInput,
  opts?: LintOptions,
): Finding[] {
  const cellGetDimThreshold =
    opts?.cellGetDimThreshold ?? DEFAULT_CELLGET_DIM_THRESHOLD;
  const clearProc = isClearProc(process);
  const findings: Finding[] = [];

  // Parse all tabs once; reuse for both walk and dead-assignment passes.
  const parsedTabs = new Map<
    TiTab,
    Extract<ReturnType<typeof parseTiCode>, { ok: true }>["ast"]
  >();
  for (const tab of TABS) {
    const src = code[tab] ?? "";
    if (src.trim() === "") continue;
    const parsed = parseTiCode(src);
    if (!parsed.ok) continue;
    parsedTabs.set(tab, parsed.ast);
  }

  // Existing per-tab rules
  for (const [tab, ast] of parsedTabs) {
    walk(ast, 0, 0, { process, tab, cellGetDimThreshold, clearProc, findings });
  }

  // dead-assignment: two-pass over all parsed tabs
  const readSet = new Set<string>();
  for (const ast of parsedTabs.values()) {
    collectReadsFromStmts(ast, readSet);
  }

  const excludeSet = new Set<string>(
    (opts?.excludeVarsFromDeadCheck ?? []).map((v) => v.toLowerCase()),
  );

  const deadCandidates: DeadCandidate[] = [];
  for (const tab of ["metadata", "data"] as const) {
    const ast = parsedTabs.get(tab);
    if (ast) collectDeadCandidates(ast, tab, deadCandidates);
  }

  const reported = new Set<string>();
  for (const c of deadCandidates) {
    if (reported.has(c.variable)) continue;
    if (excludeSet.has(c.variable)) continue;
    if (!readSet.has(c.variable)) {
      reported.add(c.variable);
      findings.push({
        process,
        tab: c.tab,
        line: c.line,
        rule: "dead-assignment",
        severity: "info",
        snippet: `${c.originalVar} = ...`,
        hint: `'${c.originalVar}' is assigned in the ${c.tab} tab but never read — remove or use it.`,
      });
    }
  }

  return findings;
}
