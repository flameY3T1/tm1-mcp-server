import { parseRules } from './rulesParser.js';

export interface RulesLintDiagnose {
  line: number;   // 0-based
  message: string;
  severity: 'error' | 'warning' | 'hint';
  ruleId: string;
}

export type ApiRequestFn = (
  method: string,
  path: string,
) => Promise<{ statusCode: number; body: string }>;

// OData key-segment encoding: double single quotes (OData literal escaping)
// before percent-encoding, matching every service's `enc` helper. Cube/dim
// names here come from semi-trusted rule text, so a `'` must not pass through raw.
const odataKey = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

// ─── String/comment neutralization ──────────────────────────────────────────

/** Replaces quoted strings with same-length spaces and strips trailing comments. */
function neutralizeLine(line: string): string {
  return line
    .replace(/'[^']*'/g, s => ' '.repeat(s.length))
    .replace(/#.*$/, '');
}

// ─── Existing helpers ────────────────────────────────────────────────────────

function hasUnclosedBracket(trimmed: string): boolean {
  const stripped = neutralizeLine(trimmed);
  let depth = 0;
  for (const ch of stripped) {
    if (ch === '[') { depth++; }
    else if (ch === ']') { depth--; }
  }
  return depth > 0;
}

function endsSemicolon(trimmed: string): boolean {
  const noComment = trimmed.replace(/#.*$/, '').trim();
  return noComment.endsWith(';');
}

/**
 * Returns the net change in parenthesis depth for a line (after neutralizing strings/comments).
 * Positive = more open parens, negative = more close parens.
 */
function parenDepthChange(trimmed: string): number {
  const stripped = neutralizeLine(trimmed);
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '(')      { delta++; }
    else if (ch === ')') { delta--; }
  }
  return delta;
}

/**
 * Returns true if the right-hand side of a rule assignment continues on the
 * next line. Triggered when the line ends with a rule-type marker (N:, C:, S:)
 * or a bare `=` (without `==`, without `=>`).
 * Examples: `[plan_source:'goal']=N:` → true, `['Kennzahl':'Personalkapazitaet'] =` → true
 */
function endsWithRuleTypeMarker(trimmed: string): boolean {
  const stripped = neutralizeLine(trimmed);
  if (/[CNS]\s*:\s*$/i.test(stripped)) { return true; }
  if (/(^|[^=])=\s*$/.test(stripped)) { return true; }
  return false;
}

/**
 * Returns true if the line ends with a TM1 backslash line-continuation marker.
 * After stripping comments and trailing whitespace, the last char must be `\`.
 */
function endsWithBackslashContinuation(trimmed: string): boolean {
  const stripped = trimmed.replace(/#.*$/, '').replace(/\s+$/, '');
  return stripped.endsWith('\\');
}

/**
 * Returns true if the line ends with a binary operator that requires an RHS
 * on the following line: `|`, `+`, `-`, `*`, `/`, `\`, `&`, `,`.
 * (Rule-specific: `\` is float division in TM1 rules.)
 */
function endsWithContinuingOperator(trimmed: string): boolean {
  const stripped = neutralizeLine(trimmed).replace(/\s+$/, '');
  return /[|+\-*/\\&,]$/.test(stripped);
}

/**
 * Returns true if the trimmed line begins with a binary operator
 * (`*`, `/`, `\`, `+`, `-`, `|`, `&`). Such lines continue the previous statement.
 */
function startsWithContinuingOperator(trimmed: string): boolean {
  return /^[*/\\+\-|&]/.test(trimmed);
}

// ─── Phase 1: Bracket extraction & syntax validation ────────────────────────

/**
 * Extracts all [...] block contents from a line (from original, not neutralized).
 * Uses neutralized positions to avoid false positives inside strings/comments.
 */
export function extractBracketRefs(line: string): string[] {
  const neutralized = neutralizeLine(line);
  const results: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < neutralized.length; i++) {
    const ch = neutralized[i];
    if (ch === '[') {
      if (depth === 0) { start = i + 1; }
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(line.slice(start, i).trim());
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Validates the syntax of a [...] cell reference content (without outer brackets).
 * Returns an error message or null if valid.
 *
 * Valid forms:
 *   'DimName':'ElemName'
 *   'DimName':{'E1','E2',...}
 *   Multiple of the above separated by commas
 */
export function validateBracketRefSyntax(content: string): string | null {
  if (content.trim() === '') {
    return '[invalid-cell-ref-syntax] Leere Zellreferenz [].';
  }
  // No quotes → likely a dynamic/variable reference (e.g. !Year) — skip validation
  if (!content.includes("'")) {
    return null;
  }

  const singleElem = `'[^']+'\\s*:\\s*'[^']+'`;
  const multiElem  = `'[^']+'\\s*:\\s*\\{\\s*'[^']+'(?:\\s*,\\s*'[^']+')*\\s*\\}`;
  const dimSpec    = `(?:${multiElem}|${singleElem})`;
  const fullRe     = new RegExp(`^\\s*${dimSpec}(?:\\s*,\\s*${dimSpec})*\\s*$`);

  if (fullRe.test(content)) { return null; }

  // Identify the offending sub-spec: split content on top-level commas, find
  // the first part that doesn't match the dimSpec pattern.
  const parts = splitTopLevelCommas(content);
  const partRe = new RegExp(`^\\s*${dimSpec}\\s*$`);
  for (const part of parts) {
    if (!partRe.test(part)) {
      return `[invalid-cell-ref-syntax] '${part.trim()}' entspricht nicht dem Format 'Dimension':'Element' oder 'Dimension':{'E1','E2'}.`;
    }
  }
  return "[invalid-cell-ref-syntax] Zellreferenz entspricht nicht dem Format ['Dimension':'Element'] oder ['Dimension':{'E1','E2'}].";
}

/** Splits a string by commas that are NOT inside `{...}` (brace-depth 0). */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') { depth++; }
    else if (ch === '}') { depth = Math.max(0, depth - 1); }
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.filter(p => p.trim().length > 0);
}

/** Parsed dimension + element(s) from a single [...] spec. */
export interface BracketDimRef {
  dim: string;
  elems: string[];
}

/**
 * Parses 'DimName':'ElemName' pairs from a bracket ref content.
 * Only handles quoted string literals — dynamic refs are ignored.
 */
export function parseBracketDimRefs(content: string): BracketDimRef[] {
  const result: BracketDimRef[] = [];
  const dimSpecRe = /'([^']+)'\s*:\s*(?:'([^']+)'|\{([^}]+)\})/g;
  let m: RegExpExecArray | null;
  while ((m = dimSpecRe.exec(content)) !== null) {
    const dim = m[1]!;
    if (m[2] !== undefined) {
      result.push({ dim, elems: [m[2]] });
    } else if (m[3] !== undefined) {
      const elems = [...m[3].matchAll(/'([^']+)'/g)].map(r => r[1]!);
      result.push({ dim, elems });
    }
  }
  return result;
}

// ─── Phase 2: DB() extraction ────────────────────────────────────────────────

interface DbCall {
  args: string[];
  cubeName: string | null;  // null = not a string literal
}

/** Splits a comma-separated DB() argument string, respecting nested parens and quotes. */
function splitArgs(argsStr: string): string[] {
  if (!argsStr.trim()) { return []; }
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';

  for (const ch of argsStr) {
    if (ch === "'" && !inString)      { inString = true;  current += ch; }
    else if (ch === "'" && inString)  { inString = false; current += ch; }
    else if (!inString && ch === '(') { depth++; current += ch; }
    else if (!inString && ch === ')') { depth--; current += ch; }
    else if (!inString && depth === 0 && ch === ',') {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  args.push(current.trim());
  return args.filter(a => a !== '');
}

/**
 * Extracts all DB(...) calls from a line with their parsed arguments.
 * Uses neutralized positions to skip DB() inside strings/comments.
 */
export function extractDbCalls(line: string): DbCall[] {
  const neutralized = neutralizeLine(line);
  const results: DbCall[] = [];
  const dbRe = /\bDB\s*\(/gi;
  let m: RegExpExecArray | null;

  while ((m = dbRe.exec(neutralized)) !== null) {
    const openPos = m.index + m[0].length - 1; // index of '('
    let depth = 1;
    let i = openPos + 1;
    while (i < neutralized.length && depth > 0) {
      if (neutralized[i] === '(')      { depth++; }
      else if (neutralized[i] === ')') { depth--; }
      i++;
    }
    if (depth !== 0) { continue; } // unmatched paren — skip

    const argsStr = line.slice(openPos + 1, i - 1);
    const args = splitArgs(argsStr);
    const first = args[0]?.trim() ?? '';
    const cubeName = first.startsWith("'") && first.endsWith("'") && first.length >= 3
      ? first.slice(1, -1)
      : null;

    results.push({ args, cubeName });
  }
  return results;
}

// ─── Synchronous linter ──────────────────────────────────────────────────────

export function lintRules(text: string): RulesLintDiagnose[] {
  const ast = parseRules(text);
  const diags: RulesLintDiagnose[] = [];

  // --- Structural checks ---

  if (ast.feedersCount === 0) {
    const hasContent = ast.lines.some(l => !l.isBlank && !l.isComment && !l.isSkipcheck);
    if (hasContent) {
      diags.push({
        line: 0,
        message: '[no-feeders-section] Kein FEEDERS;-Block gefunden. Ohne Feeder werden keine Regeln berechnet.',
        severity: 'warning',
        ruleId: 'no-feeders-section',
      });
    }
  }

  if (ast.feedersCount > 1) {
    let seen = 0;
    for (const l of ast.lines) {
      if (l.isFeedersMarker) {
        seen++;
        if (seen > 1) {
          diags.push({
            line: l.lineIndex,
            message: '[multiple-feeders] Mehrere FEEDERS;-Marker gefunden. Nur der erste wird von TM1 erkannt.',
            severity: 'error',
            ruleId: 'multiple-feeders',
          });
        }
      }
    }
  }

  // --- Per-line checks ---

  // Pre-compute: for each statement line, does the NEXT statement line start
  // with a binary operator (`*`, `/`, `\`, `+`, `-`, `|`, `&`)? If yes, the
  // current line is continued and must not be flagged missing-semicolon.
  const continuedByNextLine = new Set<number>();
  {
    let prev = -1;
    for (const l of ast.lines) {
      if (l.isBlank || l.isComment || l.isSkipcheck || l.isFeedersMarker) { continue; }
      if (prev !== -1 && startsWithContinuingOperator(l.trimmed)) {
        continuedByNextLine.add(prev);
      }
      prev = l.lineIndex;
    }
  }

  // Tracks net open parentheses across lines to detect continuation lines.
  // A line is a continuation if parenDepth > 0 before it (previous line(s) left open parens).
  let parenDepth = 0;
  // True when the previous non-blank line ended with a bare rule-type marker (N:, C:, S:)
  // meaning the expression part follows on the next line.
  let pendingRuleExpr = false;
  // True when we are inside a feeder statement whose => has not appeared yet.
  // Prevents false missing-semicolon on feeder lines like `DB(...)` that are
  // the LHS of a multi-line feeder where => comes on the following line.
  let pendingFeedersArrow = false;
  // True when previous line ended with a backslash line-continuation marker.
  let pendingBackslashCont = false;
  // True when previous line ended with a binary operator (|, +, -, *, /, \, &, ,).
  let pendingContinuingOp = false;
  // True when previous line is continued by the current one (current starts with operator).
  let pendingNextStartsWithOp = false;
  // True when previous feeder line ended with a closed target (`]` or `)`)
  // without `,`/`;`/`=>` separator — next target must NOT directly follow.
  let pendingFeederNeedsComma = false;

  for (const l of ast.lines) {
    if (l.isBlank || l.isComment || l.isSkipcheck || l.isFeedersMarker) {
      // Comments/blanks can appear mid-statement — do not reset continuation flags.
      continue;
    }

    // Is this line a continuation of a multi-line statement?
    const isContinuation = parenDepth > 0 || pendingRuleExpr || pendingFeedersArrow || pendingBackslashCont || pendingContinuingOp || pendingNextStartsWithOp;
    parenDepth = Math.max(0, parenDepth + parenDepthChange(l.trimmed));
    // Does this line leave parens open (statement continues on next line)?
    const hasOpenParens = parenDepth > 0;
    // Does this line end with a bare rule-type marker? (expression on next line)
    // Also suppresses missing-semicolon for the current line itself.
    pendingRuleExpr = endsWithRuleTypeMarker(l.trimmed);
    const thisLineEndsRuleType = pendingRuleExpr;
    // Does this line end with `\` continuation? (statement continues on next line)
    pendingBackslashCont = endsWithBackslashContinuation(l.trimmed);
    const thisLineEndsBackslash = pendingBackslashCont;
    // Does this line end with a binary operator (|, +, -, *, /, \, &, ,)?
    pendingContinuingOp = endsWithContinuingOperator(l.trimmed);
    const thisLineEndsContOp = pendingContinuingOp;
    // Does the NEXT statement line start with an operator? (computed above)
    const thisLineContinuedByNext = continuedByNextLine.has(l.lineIndex);
    pendingNextStartsWithOp = thisLineContinuedByNext;

    // Unbalanced brackets
    if (hasUnclosedBracket(l.trimmed)) {
      diags.push({
        line: l.lineIndex,
        message: '[unclosed-bracket] Nicht geschlossene eckige Klammer `[`.',
        severity: 'error',
        ruleId: 'unclosed-bracket',
      });
    }

    const hasSemi = endsSemicolon(l.trimmed);

    if (l.section === 'rules') {
      // Only flag missing-semicolon on complete statements (not mid-expression lines).
      // Also suppress when the line ends with a rule-type marker (N:, C:, S:) — expression on next line.
      if (!hasSemi && !isContinuation && !hasOpenParens && !thisLineEndsRuleType && !thisLineEndsBackslash && !thisLineEndsContOp && !thisLineContinuedByNext) {
        diags.push({
          line: l.lineIndex,
          message: '[missing-semicolon] Anweisung endet nicht mit Semikolon.',
          severity: 'error',
          ruleId: 'missing-semicolon',
        });
      }

    }

    if (l.section === 'feeders') {
      // Compute once for all feeder checks on this line.
      const neutralFeed = neutralizeLine(l.trimmed);
      const hasArrow = neutralFeed.includes('=>');

      // Missing-comma between two adjacent feeder targets (cell-ref or DB-call)
      // on separate lines — fires when prev line closed a target without
      // separator and current line starts a new target.
      if (isContinuation && pendingFeederNeedsComma) {
        const startsNewTarget = /^\s*(\[|[A-Za-z_]\w*\s*\()/.test(l.trimmed);
        if (startsNewTarget) {
          diags.push({
            line: l.lineIndex,
            message: '[feeder-missing-comma] Komma fehlt zwischen Feeder-Zielen.',
            severity: 'error',
            ruleId: 'feeder-missing-comma',
          });
        }
      }

      // Multiple targets on LHS of feeder: feeder-multi-lhs (error).
      // LHS is the part before `=>`. If LHS contains more than one closing `]`
      // at top level (whether comma-separated or whitespace-separated), it
      // means multiple cell-refs on LHS — invalid (LHS must be a single ref).
      const arrowIdx = neutralFeed.indexOf('=>');
      if (arrowIdx > 0) {
        const lhs = neutralFeed.slice(0, arrowIdx);
        const lhsCloseCount = (lhs.match(/\]/g) || []).length;
        if (lhsCloseCount > 1) {
          diags.push({
            line: l.lineIndex,
            message: '[feeder-multi-lhs] Linke Seite eines Feeders muss eine einzelne Zellreferenz sein, nicht mehrere.',
            severity: 'error',
            ruleId: 'feeder-multi-lhs',
          });
        }
      }

      // Same-line missing comma between adjacent targets:
      // `]<ws>[`, `]<ws>Func(`, `)<ws>[`, `)<ws>Func(`.
      // Only fires once per line — first match is enough.
      // Skip the LHS portion of the feeder (before `=>`) to avoid double-flagging
      // the multi-LHS case — that's covered by feeder-multi-lhs.
      const sameLineRe = /[\])]\s+(?:\[|[A-Za-z_]\w*\s*\()/g;
      let m: RegExpExecArray | null;
      while ((m = sameLineRe.exec(neutralFeed)) !== null) {
        if (arrowIdx >= 0 && m.index < arrowIdx) { continue; }
        diags.push({
          line: l.lineIndex,
          message: '[feeder-missing-comma] Komma fehlt zwischen Feeder-Zielen.',
          severity: 'error',
          ruleId: 'feeder-missing-comma',
        });
        break;
      }

      // Track whether the feeder statement is still open (no terminating `;`
      // yet). Open feeders span as many lines as needed — => may be on the
      // first line, the RHS may continue with `,` separators across lines.
      if (!isContinuation) {
        pendingFeedersArrow = !hasSemi;
      } else if (hasSemi) {
        pendingFeedersArrow = false;
      }

      // Update pendingFeederNeedsComma for the next iteration: true when the
      // current feeder line closes a target (`]` or `)`) without `,`/`;`/`=>`/
      // `\` continuation and parens are balanced.
      const stripped = neutralFeed.replace(/\s+$/, '');
      const lastChar = stripped.slice(-1);
      const endsWithTargetClose = lastChar === ']' || lastChar === ')';
      pendingFeederNeedsComma =
        pendingFeedersArrow &&
        endsWithTargetClose &&
        !hasSemi &&
        !hasOpenParens &&
        !thisLineEndsContOp &&
        !thisLineEndsBackslash &&
        !stripped.endsWith('=>');

      if (!hasSemi && !isContinuation && !hasOpenParens && !thisLineEndsRuleType && !thisLineEndsBackslash && !thisLineEndsContOp && !thisLineContinuedByNext && !pendingFeedersArrow) {
        diags.push({
          line: l.lineIndex,
          message: '[missing-semicolon] Anweisung endet nicht mit Semikolon.',
          severity: 'error',
          ruleId: 'missing-semicolon',
        });
      }

      if (!isContinuation) {
        const strippedFeed = l.trimmed.replace(/#.*$/, '').replace(/'[^']*'/g, '""');
        if (!hasArrow && !pendingFeedersArrow) {
          if (strippedFeed.includes('[')) {
            diags.push({
              line: l.lineIndex,
              message: '[feeder-missing-arrow] Feeder-Zeile ohne `=>` Operator.',
              severity: 'warning',
              ruleId: 'feeder-missing-arrow',
            });
          }
        }

        // DB() is only valid on the RHS of a feeder — the LHS must be a cell ref [...].
        const dbIdx = neutralFeed.search(/\bDB\s*\(/i);
        if (dbIdx !== -1 && (arrowIdx === -1 || dbIdx < arrowIdx)) {
          diags.push({
            line: l.lineIndex,
            message: '[feeder-db-on-lhs] DB() ist auf der linken Seite eines Feeders ungültig. Die Quell-Zellreferenz muss [...] sein, DB() nur auf der rechten Seite.',
            severity: 'error',
            ruleId: 'feeder-db-on-lhs',
          });
        }

        if (/=\s*[CNS]\s*:/i.test(strippedFeed)) {
          diags.push({
            line: l.lineIndex,
            message: '[rule-after-feeders] Regelzeile (C:/N:/S:) nach FEEDERS; — Regeln gehören vor den FEEDERS-Block.',
            severity: 'warning',
            ruleId: 'rule-after-feeders',
          });
        }
      }
    }

    // Bracket syntax validation (both sections)
    for (const refContent of extractBracketRefs(l.trimmed)) {
      const msg = validateBracketRefSyntax(refContent);
      if (msg !== null) {
        diags.push({
          line: l.lineIndex,
          message: msg,
          severity: 'hint',
          ruleId: 'invalid-cell-ref-syntax',
        });
      }
    }

    // DB() static validation (both sections)
    for (const call of extractDbCalls(l.trimmed)) {
      if (call.args.length < 2) {
        diags.push({
          line: l.lineIndex,
          message: '[db-too-few-args] DB() braucht mindestens 2 Argumente (Cube-Name + 1 Dimension).',
          severity: 'error',
          ruleId: 'db-too-few-args',
        });
      } else if (call.cubeName === null) {
        diags.push({
          line: l.lineIndex,
          message: '[db-invalid-cube-arg] Erstes DB()-Argument muss ein String-Literal sein (Cube-Name in Hochkommas).',
          severity: 'error',
          ruleId: 'db-invalid-cube-arg',
        });
      }
    }
  }

  return diags;
}

// ─── Async server linter ─────────────────────────────────────────────────────

interface LineServerData {
  lineIndex: number;
  dbCalls: DbCall[];
  bracketRefs: Array<{ dimRefs: BracketDimRef[] }>;
}

/**
 * Runs server-side lint checks against an active TM1 connection:
 * - DB() argument count vs. actual cube dimension count
 * - Element existence within the referenced dimension
 *
 * Silently returns [] if the server is unreachable or no relevant refs are found.
 */
export async function lintRulesServer(
  text: string,
  api: ApiRequestFn,
): Promise<RulesLintDiagnose[]> {
  const ast = parseRules(text);
  const diags: RulesLintDiagnose[] = [];

  // Maps: lowercase key → original casing (first occurrence wins)
  const cubeOriginal = new Map<string, string>();
  const dimOriginal  = new Map<string, string>();
  const lineData: LineServerData[] = [];

  // First pass: collect all DB() calls and valid bracket refs
  for (const l of ast.lines) {
    if (l.isBlank || l.isComment || l.isSkipcheck || l.isFeedersMarker) { continue; }

    const dbCalls = extractDbCalls(l.trimmed);
    const rawRefs = extractBracketRefs(l.trimmed);

    const bracketRefs: LineServerData['bracketRefs'] = [];
    for (const content of rawRefs) {
      // Only check refs that passed syntax validation and contain quoted literals
      if (validateBracketRefSyntax(content) === null && content.includes("'")) {
        const dimRefs = parseBracketDimRefs(content);
        if (dimRefs.length > 0) {
          bracketRefs.push({ dimRefs });
          for (const { dim } of dimRefs) {
            const lc = dim.toLowerCase();
            if (!dimOriginal.has(lc)) { dimOriginal.set(lc, dim); }
          }
        }
      }
    }

    for (const call of dbCalls) {
      if (call.cubeName !== null && call.args.length >= 2) {
        const lc = call.cubeName.toLowerCase();
        if (!cubeOriginal.has(lc)) { cubeOriginal.set(lc, call.cubeName); }
      }
    }

    const hasRelevantDb = dbCalls.some(c => c.cubeName !== null && c.args.length >= 2);
    if (hasRelevantDb || bracketRefs.length > 0) {
      lineData.push({ lineIndex: l.lineIndex, dbCalls, bracketRefs });
    }
  }

  if (cubeOriginal.size === 0 && dimOriginal.size === 0) { return []; }

  // Fetch cube dimensions in parallel (names, not just count)
  const cubeDimDetails = new Map<string, string[] | 'not-found'>();
  await Promise.all([...cubeOriginal.entries()].map(async ([lc, orig]) => {
    try {
      const res = await api('GET', `Cubes('${odataKey(orig)}')/Dimensions?$select=Name`);
      if (res.statusCode === 404) {
        cubeDimDetails.set(lc, 'not-found');
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = JSON.parse(res.body);
        const dims = Array.isArray(parsed.value)
          ? parsed.value.map((d: { Name: string }) => String(d.Name))
          : [];
        cubeDimDetails.set(lc, dims);
      }
    } catch { /* network error — skip */ }
  }));

  // Add dimensions referenced by string-literal DB() args to dimOriginal,
  // so their elements are fetched in the next step.
  for (const { dbCalls } of lineData) {
    for (const call of dbCalls) {
      if (call.cubeName === null) { continue; }
      const dims = cubeDimDetails.get(call.cubeName.toLowerCase());
      if (!Array.isArray(dims) || call.args.length !== dims.length + 1) { continue; }
      for (let i = 1; i < call.args.length; i++) {
        const arg = call.args[i]!.trim();
        if (!arg.startsWith("'") || !arg.endsWith("'") || arg.length < 3) { continue; }
        if (arg.slice(1, -1).includes("'")) { continue; } // concatenation — skip
        const dimIdx = i - 1;
        if (dimIdx < dims.length) {
          const dim = dims[dimIdx]!;
          const lc = dim.toLowerCase();
          if (!dimOriginal.has(lc)) { dimOriginal.set(lc, dim); }
        }
      }
    }
  }

  // Fetch dimension elements in parallel (one call per unique dimension)
  const dimElements = new Map<string, Set<string> | 'not-found'>();
  await Promise.all([...dimOriginal.entries()].map(async ([lc, orig]) => {
    try {
      const enc = odataKey(orig);
      const res = await api('GET',
        `Dimensions('${enc}')/Hierarchies('${enc}')/Elements?$select=Name`,
      );
      if (res.statusCode === 404) {
        dimElements.set(lc, 'not-found');
      } else if (res.statusCode >= 200 && res.statusCode < 300) {
        const parsed = JSON.parse(res.body);
        const names = new Set<string>(
          Array.isArray(parsed.value)
            ? parsed.value.map((e: { Name: string }) => String(e.Name).toLowerCase())
            : [],
        );
        dimElements.set(lc, names);
      }
    } catch { /* network error — skip */ }
  }));

  // Second pass: validate against fetched data
  for (const { lineIndex, dbCalls, bracketRefs } of lineData) {
    // DB() argument count + element checks
    for (const call of dbCalls) {
      if (call.cubeName === null || call.args.length < 2) { continue; }
      const lc = call.cubeName.toLowerCase();
      const dims = cubeDimDetails.get(lc);

      if (dims === 'not-found') {
        diags.push({
          line: lineIndex,
          message: `[db-unknown-cube] Cube '${call.cubeName}' wurde auf dem Server nicht gefunden.`,
          severity: 'warning',
          ruleId: 'db-unknown-cube',
        });
      } else if (Array.isArray(dims)) {
        const expected = dims.length + 1; // cube name + one arg per dimension
        if (call.args.length !== expected) {
          diags.push({
            line: lineIndex,
            message: `[db-arg-count-mismatch] DB('${call.cubeName}') erwartet ${expected} Argument${expected !== 1 ? 'e' : ''} (${dims.length} Dimension${dims.length !== 1 ? 'en' : ''}), hat aber ${call.args.length}.`,
            severity: 'error',
            ruleId: 'db-arg-count-mismatch',
          });
        } else {
          // Element existence check for string-literal dimension args
          for (let i = 1; i < call.args.length; i++) {
            const arg = call.args[i]!.trim();
            if (!arg.startsWith("'") || !arg.endsWith("'") || arg.length < 3) { continue; }
            const inner = arg.slice(1, -1);
            if (inner.includes("'")) { continue; } // concatenation — skip
            const dimIdx = i - 1;
            const dim = dims[dimIdx]!;
            const elemSet = dimElements.get(dim.toLowerCase());
            if (elemSet instanceof Set && !elemSet.has(inner.toLowerCase())) {
              diags.push({
                line: lineIndex,
                message: `[db-element-not-found] Element '${inner}' in Dimension '${dim}' (DB()-Arg ${i + 1}) nicht gefunden.`,
                severity: 'warning',
                ruleId: 'db-element-not-found',
              });
            }
          }
        }
      }
    }

    // Element existence check
    for (const { dimRefs } of bracketRefs) {
      for (const { dim, elems } of dimRefs) {
        const dimLc = dim.toLowerCase();
        const elemSet = dimElements.get(dimLc);

        if (elemSet === 'not-found') {
          diags.push({
            line: lineIndex,
            message: `[dimension-not-found] Dimension '${dim}' wurde auf dem Server nicht gefunden.`,
            severity: 'error',
            ruleId: 'dimension-not-found',
          });
          continue;
        }

        if (elemSet instanceof Set) {
          for (const elem of elems) {
            if (!elemSet.has(elem.toLowerCase())) {
              diags.push({
                line: lineIndex,
                message: `[element-not-found] Element '${elem}' in Dimension '${dim}' nicht gefunden.`,
                severity: 'warning',
                ruleId: 'element-not-found',
              });
            }
          }
        }
      }
    }
  }

  return diags;
}
