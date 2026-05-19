/**
 * Per-cube rules complexity metrics (regex/line-based MVP).
 *
 * Reuses parseRules (line classification + section tracking) and extractDbCalls
 * (string/comment-aware DB() extraction). A future AST upgrade can replace the
 * rule-line heuristic without changing this file's contract.
 */
import { parseRules } from "../callgraph/rulesParser.js";
import { extractDbCalls } from "../callgraph/rulesLinter.js";

export interface RulesMetrics {
  cube: string;
  /** Non-blank, non-comment lines in the rules section. */
  rulesLoc: number;
  /** Non-blank, non-comment lines in the feeders section. */
  feedersLoc: number;
  /** Rule-area lines (start with `[`) in the rules section. */
  ruleCount: number;
  /** Rule-area lines (start with `[`) in the feeders section. */
  feederCount: number;
  /** Lines starting with `#`. */
  commentLines: number;
  /** commentLines / max(rulesLoc + feedersLoc + commentLines, 1). 0..1. */
  commentRatio: number;
  /** `skipcheck;` directive present in the rules section. */
  hasSkipcheck: boolean;
  /** `feedstrings;` directive present in the rules section. */
  hasFeedstrings: boolean;
  /** Total DB(...) calls across all rule/feeder lines (string-literal aware). */
  dbCallCount: number;
  /** Distinct target cubes from DB('CubeName', ...) calls (string literals only). */
  coupledCubes: string[];
  /** Heuristic: rulesLoc + 2*ruleCount + 3*dbCallCount + 5*coupledCubes.length. */
  score: number;
}

const RULE_LINE_RE = /^\[/;

function stripQuotes(s: string): string {
  // Strip matching pair only — leave mismatched quotes alone so we don't
  // mangle an already-broken extracted argument (`'Foo"` stays `'Foo"`).
  return s.replace(/^(['"])(.*)\1$/, "$2");
}

export function computeRulesMetrics(cube: string, rulesText: string): RulesMetrics {
  if (!rulesText || rulesText.trim() === "") {
    return {
      cube,
      rulesLoc: 0,
      feedersLoc: 0,
      ruleCount: 0,
      feederCount: 0,
      commentLines: 0,
      commentRatio: 0,
      hasSkipcheck: false,
      hasFeedstrings: false,
      dbCallCount: 0,
      coupledCubes: [],
      score: 0,
    };
  }

  const ast = parseRules(rulesText);
  let rulesLoc = 0;
  let feedersLoc = 0;
  let ruleCount = 0;
  let feederCount = 0;
  let commentLines = 0;
  let dbCallCount = 0;
  const coupled = new Set<string>();

  for (const line of ast.lines) {
    if (line.isBlank) continue;
    if (line.isComment) {
      commentLines++;
      continue;
    }
    // Section markers (`feeders;`) are dividers, not code — skip from LOC.
    if (line.isFeedersMarker) continue;
    if (line.section === "rules") {
      rulesLoc++;
      if (RULE_LINE_RE.test(line.trimmed)) ruleCount++;
    } else {
      feedersLoc++;
      if (RULE_LINE_RE.test(line.trimmed)) feederCount++;
    }
    for (const call of extractDbCalls(line.trimmed)) {
      dbCallCount++;
      if (call.cubeName) {
        const c = stripQuotes(call.cubeName);
        if (c !== "") coupled.add(c);
      }
    }
  }

  const denom = rulesLoc + feedersLoc + commentLines;
  const commentRatio = denom === 0 ? 0 : commentLines / denom;
  const coupledCubes = [...coupled].sort();
  const score =
    rulesLoc + 2 * ruleCount + 3 * dbCallCount + 5 * coupledCubes.length;

  return {
    cube,
    rulesLoc,
    feedersLoc,
    ruleCount,
    feederCount,
    commentLines,
    commentRatio,
    hasSkipcheck: ast.hasSkipcheck,
    hasFeedstrings: ast.hasFeedstrings,
    dbCallCount,
    coupledCubes,
    score,
  };
}
