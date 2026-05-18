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
} from "../callgraph/types.js";

export type TiTab = "prolog" | "metadata" | "data" | "epilog";

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
    /** Heuristic: loc + 2*branches + 3*maxNesting. */
    score: number;
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

export function computeTabMetrics(src: string): TabMetrics {
  const counts = classifyLines(src);
  const parseRes = parseTiCode(src);
  const acc = { branches: 0, maxNesting: 0 };
  let parseError = false;
  if (parseRes.ok) {
    walk(parseRes.ast, 0, acc);
  } else {
    parseError = true;
  }
  return {
    loc: counts.loc,
    commentLines: counts.commentLines,
    blankLines: counts.blankLines,
    branches: acc.branches,
    maxNesting: acc.maxNesting,
    parseError,
  };
}

export function computeProcessMetrics(
  name: string,
  code: ProcessCodeInput,
): ProcessMetrics {
  const tabs = {} as Record<TiTab, TabMetrics>;
  for (const t of TABS) tabs[t] = computeTabMetrics(code[t] ?? "");

  let loc = 0;
  let commentLines = 0;
  let branches = 0;
  let maxNesting = 0;
  for (const t of TABS) {
    loc += tabs[t].loc;
    commentLines += tabs[t].commentLines;
    branches += tabs[t].branches;
    if (tabs[t].maxNesting > maxNesting) maxNesting = tabs[t].maxNesting;
  }
  const score = loc + 2 * branches + 3 * maxNesting;
  const denom = loc + commentLines;
  const commentRatio = denom === 0 ? 0 : commentLines / denom;

  return {
    name,
    tabs,
    totals: { loc, commentLines, branches, maxNesting, score, commentRatio },
  };
}
