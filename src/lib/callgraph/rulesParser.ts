export interface ParsedRulesLine {
  lineIndex: number;
  raw: string;
  trimmed: string;
  isComment: boolean;
  isBlank: boolean;
  isSkipcheck: boolean;
  isFeedersMarker: boolean;
  section: 'rules' | 'feeders';
}

export interface RulesAst {
  lines: ParsedRulesLine[];
  hasSkipcheck: boolean;
  skipchecLine: number;
  feedersLineIndex: number;
  feedersCount: number;
}

export function parseRules(text: string): RulesAst {
  const rawLines = text.split('\n');
  let feedersCount = 0;
  let feedersLineIndex = -1;
  let hasSkipcheck = false;
  let skipchecLine = -1;
  let inFeeders = false;

  const lines: ParsedRulesLine[] = rawLines.map((raw, lineIndex) => {
    const trimmed = raw.replace(/\r$/, '').trim();
    const isComment = trimmed.startsWith('#');
    const isBlank = trimmed === '';
    const isSkipcheck = /^skipcheck\s*;?\s*$/i.test(trimmed);
    const isFeedersMarker = /^feeders\s*;?\s*$/i.test(trimmed);

    if (isSkipcheck && !hasSkipcheck) {
      hasSkipcheck = true;
      skipchecLine = lineIndex;
    }
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
      isFeedersMarker,
      section: inFeeders ? 'feeders' : 'rules',
    };
  });

  return { lines, hasSkipcheck, skipchecLine, feedersLineIndex, feedersCount };
}
