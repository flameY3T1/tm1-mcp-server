export interface ParsedRulesLine {
  lineIndex: number;
  raw: string;
  trimmed: string;
  isComment: boolean;
  isBlank: boolean;
  isSkipcheck: boolean;
  isFeedstrings: boolean;
  isFeedersMarker: boolean;
  /** `STET` keyword present outside string literals / comments (rules side). */
  hasStet: boolean;
  /** `IF(` call present outside string literals / comments (rule RHS or feeder LHS guard). */
  hasIfGuard: boolean;
  section: 'rules' | 'feeders';
}

/** Replace quoted strings with same-length spaces and strip trailing `#…` comment. */
function neutralize(line: string): string {
  return line
    .replace(/'[^']*'/g, (s) => ' '.repeat(s.length))
    .replace(/#.*$/, '');
}

export interface RulesAst {
  lines: ParsedRulesLine[];
  hasSkipcheck: boolean;
  skipchecLine: number;
  hasFeedstrings: boolean;
  feedstringsLine: number;
  feedersLineIndex: number;
  feedersCount: number;
}

export function parseRules(text: string): RulesAst {
  const rawLines = text.split('\n');
  let feedersCount = 0;
  let feedersLineIndex = -1;
  let hasSkipcheck = false;
  let skipchecLine = -1;
  let hasFeedstrings = false;
  let feedstringsLine = -1;
  let inFeeders = false;

  const lines: ParsedRulesLine[] = rawLines.map((raw, lineIndex) => {
    const trimmed = raw.replace(/\r$/, '').trim();
    const isComment = trimmed.startsWith('#');
    const isBlank = trimmed === '';
    const isSkipcheck = /^skipcheck\s*;?\s*$/i.test(trimmed);
    const isFeedstrings = /^feedstrings\s*;?\s*$/i.test(trimmed);
    const isFeedersMarker = /^feeders\s*;?\s*$/i.test(trimmed);
    const neutralized = isComment || isBlank ? '' : neutralize(trimmed);
    const hasStet = /\bstet\b/i.test(neutralized);
    const hasIfGuard = /\bif\s*\(/i.test(neutralized);

    if (isSkipcheck && !hasSkipcheck) {
      hasSkipcheck = true;
      skipchecLine = lineIndex;
    }
    if (isFeedstrings && !hasFeedstrings) {
      hasFeedstrings = true;
      feedstringsLine = lineIndex;
    }
    // Capture section BEFORE the marker flips state: the `FEEDERS;` marker
    // line itself belongs to the rules section it closes — only the lines
    // that follow it carry `section: 'feeders'`. Otherwise consumers that
    // iterate `section === 'feeders'` would sweep the marker too unless
    // they also test `isFeedersMarker`.
    const section: 'rules' | 'feeders' = inFeeders ? 'feeders' : 'rules';
    if (isFeedersMarker) {
      feedersCount++;
      if (feedersCount === 1) { feedersLineIndex = lineIndex; }
      inFeeders = true;
    }

    return {
      lineIndex,
      raw,
      trimmed,
      isComment,
      isBlank,
      isSkipcheck,
      isFeedstrings,
      isFeedersMarker,
      hasStet,
      hasIfGuard,
      section,
    };
  });

  return {
    lines,
    hasSkipcheck,
    skipchecLine,
    hasFeedstrings,
    feedstringsLine,
    feedersLineIndex,
    feedersCount,
  };
}
