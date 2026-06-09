/**
 * Per-process complexity metrics derived from TI source + variables.
 *
 * Metrics are designed to surface real maintainability pain (deep branching,
 * uneven distribution across tabs, missing comments) — not vanity counts like
 * raw variable totals.
 */
import { parseTiCode } from "../callgraph/tiParser.js";
import type {
  TiStatement,
  TiIfBlock,
  TiWhileBlock,
  TiFunctionCall,
} from "../callgraph/types.js";

export type TiTab = "prolog" | "metadata" | "data" | "epilog";

/**
 * Tunable weights for the v2 cognitive-style score. All optional; unset fields
 * fall back to the defaults below. Exposed so callers (e.g. tm1_audit_complexity)
 * can recalibrate without recompiling.
 */
export interface ScoreWeights {
  /** Base cost of a single while loop (multiplied by nestMult^loopDepth). */
  loopBase: number;
  /** Geometric factor applied per enclosing loop — this is the "multiplication". */
  nestMult: number;
  /** Base cost of an if/elseif, scaled by condition complexity and if-depth. */
  ifBase: number;
  /** Penalty per hot op (CellPutN, ASCIIOutput, ExecuteProcess, …) per loop depth. */
  hotPenalty: number;
  /** Max fraction (0..1) of scoreV2 discounted by commentRatio. 0 = off (default). */
  commentDiscountMax: number;
}

/** Partial override accepted from callers; undefined fields fall back to defaults. */
export type ScoreWeightsInput = {
  [K in keyof ScoreWeights]?: ScoreWeights[K] | undefined;
};

const DEFAULT_WEIGHTS: ScoreWeights = {
  loopBase: 2,
  nestMult: 3,
  ifBase: 1,
  hotPenalty: 2,
  commentDiscountMax: 0,
};

/**
 * Merge caller overrides onto defaults, ignoring undefined values so an
 * explicitly-undefined field (e.g. from an omitted Zod key) never clobbers a
 * default with undefined.
 */
function resolveWeights(weights?: ScoreWeightsInput): ScoreWeights {
  const w: ScoreWeights = { ...DEFAULT_WEIGHTS };
  if (weights) {
    for (const k of Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoreWeights>) {
      const v = weights[k];
      if (typeof v === "number") w[k] = v;
    }
  }
  return w;
}

/**
 * Functions whose execution inside a loop is a recognised performance hot path
 * in TI (cell writes, file I/O, nested process calls). Case-insensitive match.
 */
const HOT_OPS = new Set<string>([
  "cellputn",
  "cellputs",
  "asciioutput",
  "textoutput",
  "executeprocess",
  "runprocess",
  "odbcoutput",
]);

/**
 * Count AND/OR connectors (`&`, `%`) in a TI condition, ignoring any that sit
 * inside single-quoted string literals. Complexity = 1 + connector count, so a
 * lone comparison scores 1 and each extra clause adds 1.
 */
function conditionComplexity(condition: string): number {
  let connectors = 0;
  let inString = false;
  for (let i = 0; i < condition.length; i++) {
    const c = condition[i];
    if (c === "'") {
      // Doubled '' is an escaped quote inside a string — skip the pair.
      if (inString && condition[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "&" || c === "%") connectors++;
  }
  return 1 + connectors;
}

export interface TabMetrics {
  /** Non-blank, non-comment source lines. */
  loc: number;
  /** Lines starting with `#`. */
  commentLines: number;
  /** Lines that are purely whitespace. */
  blankLines: number;
  /** if + elseIf + while statements (recursive). */
  branches: number;
  /** Deepest control-flow nesting reached (0 = no control flow). */
  maxNesting: number;
  /** v2: Σ loopBase * nestMult^loopDepth over every while (multiplicative nesting). */
  loopCost: number;
  /** v2: Σ ifBase * conditionComplexity * (1 + ifDepth) over every if/elseif. */
  ifCost: number;
  /** v2: Σ hotPenalty * loopDepth over hot ops executed inside loops. */
  hotInLoop: number;
  /** True if the parser rejected this tab — metrics still emitted for raw lines. */
  parseError: boolean;
}

export interface ProcessMetrics {
  name: string;
  tabs: Record<TiTab, TabMetrics>;
  totals: {
    loc: number;
    commentLines: number;
    branches: number;
    maxNesting: number;
    /** Heuristic (v1): loc + 2*branches + 3*maxNesting. Unchanged for compatibility. */
    score: number;
    /** v2: Σ loopCost across tabs (loop nesting multiplies). */
    loopCost: number;
    /** v2: Σ ifCost across tabs (condition complexity × if-depth). */
    ifCost: number;
    /** v2: Σ hotInLoop across tabs (hot ops penalised by loop depth). */
    hotInLoop: number;
    /** v2: loc + ifCost + loopCost + hotInLoop, optionally discounted by comments. */
    scoreV2: number;
    /** commentLines / max(loc + commentLines, 1). 0..1. */
    commentRatio: number;
  };
}

export interface ProcessCodeInput {
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
}

const TABS: ReadonlyArray<TiTab> = ["prolog", "metadata", "data", "epilog"];

// Bedrock-generated TI processes pack many statements onto one line (e.g.
// `IF(x);y=1;ENDIF;`). The parser is line-oriented for some block keywords,
// so we normalize by inserting a newline after every top-level `;` (outside
// of strings and `#` line-comments) before parsing. Raw LOC counts use the
// original source via classifyLines.
function splitMultiStatementLines(src: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inLineComment) {
      out += c;
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inString) {
      out += c;
      if (c === "'") {
        if (src[i + 1] === "'") {
          out += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (c === "'") {
      inString = true;
      out += c;
      continue;
    }
    if (c === "#") {
      inLineComment = true;
      out += c;
      continue;
    }
    if (c === ";") {
      out += ";";
      const next = src[i + 1];
      if (next !== undefined && next !== "\n" && next !== "\r") {
        out += "\n";
      }
      continue;
    }
    out += c;
  }
  return out;
}

function classifyLines(src: string): {
  loc: number;
  commentLines: number;
  blankLines: number;
} {
  let loc = 0;
  let commentLines = 0;
  let blankLines = 0;
  for (const raw of src.split(/\r?\n/)) {
    const t = raw.trim();
    if (t === "") blankLines++;
    else if (t.startsWith("#")) commentLines++;
    else loc++;
  }
  return { loc, commentLines, blankLines };
}

function walk(
  stmts: TiStatement[],
  depth: number,
  acc: { branches: number; maxNesting: number },
) {
  for (const s of stmts) {
    if (s.type === "if") {
      const ifBlk = s as TiIfBlock;
      acc.branches += 1 + ifBlk.elseIfClauses.length;
      const nextDepth = depth + 1;
      if (nextDepth > acc.maxNesting) acc.maxNesting = nextDepth;
      walk(ifBlk.thenBody, nextDepth, acc);
      for (const c of ifBlk.elseIfClauses) walk(c.body, nextDepth, acc);
      walk(ifBlk.elseBody, nextDepth, acc);
    } else if (s.type === "while") {
      const whBlk = s as TiWhileBlock;
      acc.branches += 1;
      const nextDepth = depth + 1;
      if (nextDepth > acc.maxNesting) acc.maxNesting = nextDepth;
      walk(whBlk.body, nextDepth, acc);
    }
  }
}

/**
 * v2 cost accumulator. Tracks loop and if nesting separately as it descends:
 * loop cost grows geometrically with enclosing loops, if cost grows with
 * condition complexity and if-depth, hot ops are penalised by loop depth.
 */
function walkCost(
  stmts: TiStatement[],
  loopDepth: number,
  ifDepth: number,
  w: ScoreWeights,
  acc: { loopCost: number; ifCost: number; hotInLoop: number },
): void {
  for (const s of stmts) {
    if (s.type === "if") {
      const ifBlk = s as TiIfBlock;
      acc.ifCost +=
        w.ifBase * conditionComplexity(ifBlk.condition) * (1 + ifDepth);
      for (const c of ifBlk.elseIfClauses) {
        acc.ifCost +=
          w.ifBase * conditionComplexity(c.condition) * (1 + ifDepth);
      }
      walkCost(ifBlk.thenBody, loopDepth, ifDepth + 1, w, acc);
      for (const c of ifBlk.elseIfClauses)
        walkCost(c.body, loopDepth, ifDepth + 1, w, acc);
      walkCost(ifBlk.elseBody, loopDepth, ifDepth + 1, w, acc);
    } else if (s.type === "while") {
      const whBlk = s as TiWhileBlock;
      acc.loopCost += w.loopBase * Math.pow(w.nestMult, loopDepth);
      walkCost(whBlk.body, loopDepth + 1, ifDepth, w, acc);
    } else if (s.type === "functionCall") {
      const fn = s as TiFunctionCall;
      if (loopDepth > 0 && HOT_OPS.has(fn.name.toLowerCase())) {
        acc.hotInLoop += w.hotPenalty * loopDepth;
      }
    }
  }
}

export function computeTabMetrics(
  src: string,
  weights?: ScoreWeightsInput,
): TabMetrics {
  const w = resolveWeights(weights);
  const counts = classifyLines(src);
  const parseRes = parseTiCode(splitMultiStatementLines(src));
  const acc = { branches: 0, maxNesting: 0 };
  const cost = { loopCost: 0, ifCost: 0, hotInLoop: 0 };
  let parseError = false;
  if (parseRes.ok) {
    walk(parseRes.ast, 0, acc);
    walkCost(parseRes.ast, 0, 0, w, cost);
  } else {
    parseError = true;
  }
  return {
    loc: counts.loc,
    commentLines: counts.commentLines,
    blankLines: counts.blankLines,
    branches: acc.branches,
    maxNesting: acc.maxNesting,
    loopCost: cost.loopCost,
    ifCost: cost.ifCost,
    hotInLoop: cost.hotInLoop,
    parseError,
  };
}

export function computeProcessMetrics(
  name: string,
  code: ProcessCodeInput,
  weights?: ScoreWeightsInput,
): ProcessMetrics {
  const w = resolveWeights(weights);
  const tabs = {} as Record<TiTab, TabMetrics>;
  for (const t of TABS) tabs[t] = computeTabMetrics(code[t] ?? "", w);

  let loc = 0;
  let commentLines = 0;
  let branches = 0;
  let maxNesting = 0;
  let loopCost = 0;
  let ifCost = 0;
  let hotInLoop = 0;
  for (const t of TABS) {
    loc += tabs[t].loc;
    commentLines += tabs[t].commentLines;
    branches += tabs[t].branches;
    if (tabs[t].maxNesting > maxNesting) maxNesting = tabs[t].maxNesting;
    loopCost += tabs[t].loopCost;
    ifCost += tabs[t].ifCost;
    hotInLoop += tabs[t].hotInLoop;
  }
  const score = loc + 2 * branches + 3 * maxNesting;
  const denom = loc + commentLines;
  const commentRatio = denom === 0 ? 0 : commentLines / denom;
  const rawV2 = loc + ifCost + loopCost + hotInLoop;
  const discount = Math.min(Math.max(w.commentDiscountMax, 0), 1) * commentRatio;
  const scoreV2 = rawV2 * (1 - discount);

  return {
    name,
    tabs,
    totals: {
      loc,
      commentLines,
      branches,
      maxNesting,
      score,
      loopCost,
      ifCost,
      hotInLoop,
      scoreV2,
      commentRatio,
    },
  };
}
