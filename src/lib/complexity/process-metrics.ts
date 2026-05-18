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

export function computeTabMetrics(src: string): TabMetrics {
  const counts = classifyLines(src);
  const parseRes = parseTiCode(splitMultiStatementLines(src));
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
