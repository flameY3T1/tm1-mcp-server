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
  TiIfBlock,
  TiWhileBlock,
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
      const blk = s as TiIfBlock;
      walk(blk.thenBody, loopDepth, ifDepth + 1, ctx);
      for (const c of blk.elseIfClauses)
        walk(c.body, loopDepth, ifDepth + 1, ctx);
      walk(blk.elseBody, loopDepth, ifDepth + 1, ctx);
    } else if (s.type === "while") {
      const blk = s as TiWhileBlock;
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
  for (const tab of TABS) {
    const src = code[tab] ?? "";
    if (src.trim() === "") continue;
    const parsed = parseTiCode(src);
    if (!parsed.ok) continue;
    walk(parsed.ast, 0, 0, {
      process,
      tab,
      cellGetDimThreshold,
      clearProc,
      findings,
    });
  }
  return findings;
}
