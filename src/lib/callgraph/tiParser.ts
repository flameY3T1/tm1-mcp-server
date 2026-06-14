import {
  type TiParseResult,
  type TiStatement,
  type TiAssignment,
  type TiIfBlock,
  type TiWhileBlock,
  type TiFunctionCall,
} from './types.js';

/**
 * Parses TI (TurboIntegrator) source code into an AST.
 *
 * Handles:
 * - Assignments: `variable = expression;`
 * - IF/ELSEIF/ELSE/ENDIF blocks (nested)
 * - WHILE/END loops (nested)
 * - Function calls as statements: `FunctionName(args...);`
 * - CellGetN/CellGetS detection in assignment expressions
 * - Comment lines (starting with #) and blank lines are skipped
 */
export function parseTiCode(code: string): TiParseResult {
  const rawLines = code.split('\n');
  const lines = joinContinuationLines(rawLines);
  try {
    const { statements } = parseBlock(lines, 0, null);
    return { ok: true, ast: statements };
  } catch (e) {
    if (e instanceof ParseError) {
      return { ok: false, error: { line: e.line, message: e.message } };
    }
    throw e;
  }
}

/**
 * Joins continuation lines into single logical lines to handle multi-line statements.
 * A line is a continuation when prior lines have left parentheses open (depth > 0).
 * Preserves the total line count so error line numbers remain accurate:
 * the joined content is placed on the FIRST line; continuation lines become empty.
 */
export function joinContinuationLines(lines: string[]): string[] {
  const result = [...lines];
  let depth = 0;
  let inStr = false; // string-literal state carried across lines (TM1 allows multi-line strings)
  let pendingIdx = -1;
  let pendingContent = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    // While inside an unterminated string literal, absorb every line as part
    // of the same statement. `#` and blank lines are NOT comments here.
    // Join with a single space to keep downstream regexes (which use `.`) happy.
    if (inStr) {
      if (pendingIdx === -1) {
        pendingIdx = i;
        pendingContent = raw;
      } else {
        pendingContent += ' ' + raw.replace(/\r$/, '');
        result[i] = '';
      }
      for (const ch of raw) {
        if (ch === "'") { inStr = !inStr; }
        else if (!inStr && ch === '(') { depth++; }
        else if (!inStr && ch === ')') { depth = Math.max(0, depth - 1); }
      }
      if (!inStr && depth === 0) {
        result[pendingIdx] = pendingContent;
        pendingIdx = -1;
        pendingContent = '';
      }
      continue;
    }

    if (trimmed === '' || trimmed.startsWith('#')) {
      if (pendingIdx !== -1) {
        result[i] = ''; // absorb blank/comment into the pending multi-line statement
      }
      continue;
    }

    if (pendingIdx === -1) {
      pendingIdx = i;
      pendingContent = trimmed;
    } else {
      pendingContent += ' ' + trimmed;
      result[i] = '';
    }

    // Count net paren change + detect unterminated string (carries to next line).
    for (const ch of trimmed) {
      if (ch === "'") { inStr = !inStr; }
      else if (!inStr && ch === '(') { depth++; }
      else if (!inStr && ch === ')') { depth = Math.max(0, depth - 1); }
    }

    // Detect trailing operator that requires a RHS on the next line.
    // Ignores comparison/logical operators that could end a sub-expression
    // (==, <>, <=, >=, !=) and lone `<` / `>`.
    const noComment = trimmed.replace(/#.*$/, '').trim();
    const endsWithContinuingOp =
      // bare `=` (not `==`, not `<=`, not `>=`, not `<>`, not `!=`)
      (/(?:^|[^=<>!])=\s*$/.test(noComment)) ||
      // string-concat / arithmetic / logical with no RHS yet
      /[|+*/&,]\s*$/.test(noComment);

    if (!inStr && depth === 0 && !endsWithContinuingOp) {
      result[pendingIdx] = pendingContent;
      pendingIdx = -1;
      pendingContent = '';
    }
  }

  if (pendingIdx !== -1) {
    result[pendingIdx] = pendingContent;
  }

  return result;
}

class ParseError extends Error {
  constructor(public line: number, message: string) {
    super(message);
  }
}

interface ParseBlockResult {
  statements: TiStatement[];
  nextIndex: number;
}

/**
 * Parse a block of lines starting at `startIndex`.
 * `terminators` indicates what keyword ends this block:
 *   - null: top-level (no terminator expected)
 *   - 'endif': inside an IF block
 *   - 'end': inside a WHILE block
 */
function parseBlock(
  lines: string[],
  startIndex: number,
  terminator: 'endif' | 'end' | null,
): ParseBlockResult {
  const statements: TiStatement[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    // Skip blank lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const upper = trimmed.toUpperCase();
    const lineNum = i + 1; // 1-based line numbers

    // Check for double semicolon (two semicolons on one line is always an error)
    if (trimmed.includes(';;')) {
      throw new ParseError(lineNum, `Doppeltes Semikolon in Zeile ${lineNum}: Jedes Statement braucht genau ein Semikolon`);
    }

    // Check for block terminators
    // Return nextIndex = i (do NOT consume the terminator line)
    // so the caller (parseIfBlock / parseWhileBlock) can handle it.
    if (upper === 'ENDIF;' || upper === 'ENDIF') {
      if (terminator === 'endif') {
        return { statements, nextIndex: i };
      }
      throw new ParseError(lineNum, `Unerwartetes ENDIF ohne zugehöriges IF in Zeile ${lineNum}`);
    }

    if (upper === 'END;' || upper === 'END') {
      if (terminator === 'end') {
        return { statements, nextIndex: i };
      }
      throw new ParseError(lineNum, `Unerwartetes END ohne zugehöriges WHILE in Zeile ${lineNum}`);
    }

    // ELSEIF / ELSE are handled by the IF parser, not here
    if (upper.startsWith('ELSEIF') || upper === 'ELSE;' || upper === 'ELSE') {
      if (terminator === 'endif') {
        // Return to the IF parser to handle ELSEIF/ELSE
        return { statements, nextIndex: i };
      }
      throw new ParseError(lineNum, `Unerwartetes ${upper.startsWith('ELSEIF') ? 'ELSEIF' : 'ELSE'} ohne zugehöriges IF in Zeile ${lineNum}`);
    }

    // Single-line IF/ENDIF: `IF(cond); stmt1; stmt2; ENDIF;`
    if (upper.startsWith('IF') && /^IF\s*\(/i.test(trimmed) && hasTrailingEndif(trimmed)) {
      const inlineIf = tryParseSingleLineIf(trimmed, lineNum);
      if (inlineIf) {
        statements.push(inlineIf);
        i++;
        continue;
      }
    }

    // IF block
    if (upper.startsWith('IF') && /^IF\s*\(/i.test(trimmed)) {
      const result = parseIfBlock(lines, i);
      statements.push(result.ifBlock);
      i = result.nextIndex;
      continue;
    }

    // WHILE block
    if (upper.startsWith('WHILE') && /^WHILE\s*\(/i.test(trimmed)) {
      const result = parseWhileBlock(lines, i);
      statements.push(result.whileBlock);
      i = result.nextIndex;
      continue;
    }

    // Assignment: variable = expression;
    // Check for empty right-hand side: y =; or y = ;
    if (/^[A-Za-z_]\w*\s*=\s*;$/.test(trimmed)) {
      const varName = (trimmed.split(/\s*=/)[0] ?? '').trim();
      throw new ParseError(lineNum, `Leere Zuweisung in Zeile ${lineNum}: "${varName}" hat keinen Wert (z.B. ${varName} = 1; oder ${varName} = 'text';)`);
    }
    // First check if line looks like an assignment but is missing semicolon
    if (/^[A-Za-z_]\w*\s*=\s*.+$/.test(trimmed) && !trimmed.endsWith(';')) {
      const upperFirst = (trimmed.split(/[\s=(]/)[0] ?? '').toUpperCase();
      if (!['IF', 'ELSEIF', 'ELSE', 'ENDIF', 'WHILE', 'END'].includes(upperFirst)) {
        throw new ParseError(lineNum, `Fehlendes Semikolon am Ende der Zeile ${lineNum}`);
      }
    }
    const assignment = tryParseAssignment(trimmed, lineNum);
    if (assignment) {
      statements.push(assignment);
      i++;
      continue;
    }

    // Function call: FunctionName(args...);
    // Check for missing semicolon on function calls
    if (/^[A-Za-z_]\w*\s*\(/.test(trimmed) && !trimmed.endsWith(';')) {
      const upperFirst = (trimmed.split(/[\s(]/)[0] ?? '').toUpperCase();
      if (!['IF', 'ELSEIF', 'WHILE'].includes(upperFirst)) {
        throw new ParseError(lineNum, `Fehlendes Semikolon am Ende der Zeile ${lineNum}`);
      }
    }
    const funcCall = tryParseFunctionCall(trimmed, lineNum);
    if (funcCall) {
      statements.push(funcCall);
      i++;
      continue;
    }

    // Bare keyword (no parentheses): ItemSkip; ItemReject; ProcessQuit; etc.
    // Check for missing semicolon on bare keywords
    const cleanedForBareCheck = trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed.trim();
    if (BARE_KEYWORDS.has(cleanedForBareCheck.toLowerCase()) && !trimmed.endsWith(';')) {
      throw new ParseError(lineNum, `Fehlendes Semikolon am Ende der Zeile ${lineNum}`);
    }
    const bareKeyword = tryParseBareKeyword(trimmed, lineNum);
    if (bareKeyword) {
      statements.push(bareKeyword);
      i++;
      continue;
    }

    // Unknown line — not valid TI syntax
    throw new ParseError(lineNum, `Unbekannte Anweisung in Zeile ${lineNum}: "${trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed}" — erwartet wird eine Zuweisung (var = expr;), ein Funktionsaufruf (Fn(...);) oder ein Schlüsselwort`);
  }

  // If we expected a terminator but reached end of file
  if (terminator === 'endif') {
    throw new ParseError(lines.length, `Fehlendes ENDIF — IF-Block wurde nicht geschlossen`);
  }
  if (terminator === 'end') {
    throw new ParseError(lines.length, `Fehlendes END — WHILE-Block wurde nicht geschlossen`);
  }

  return { statements, nextIndex: i };
}


interface IfParseResult {
  ifBlock: TiIfBlock;
  nextIndex: number;
}

function parseIfBlock(lines: string[], startIndex: number): IfParseResult {
  const trimmed = lines[startIndex]!.trim();
  const lineNum = startIndex + 1;
  const condition = extractCondition(trimmed, 'IF');

  // Parse THEN body
  const thenResult = parseBlock(lines, startIndex + 1, 'endif');
  const thenBody = thenResult.statements;
  let i = thenResult.nextIndex;

  const elseIfClauses: Array<{ condition: string; body: TiStatement[]; line: number }> = [];
  let elseBody: TiStatement[] = [];

  // Handle ELSEIF and ELSE clauses
  while (i < lines.length) {
    const currentTrimmed = lines[i]!.trim();
    const currentUpper = currentTrimmed.toUpperCase();

    if (currentUpper === 'ENDIF;' || currentUpper === 'ENDIF') {
      // End of IF block
      return {
        ifBlock: { type: 'if', condition, thenBody, elseIfClauses, elseBody, line: lineNum },
        nextIndex: i + 1,
      };
    }

    if (currentUpper.startsWith('ELSEIF') && /^ELSEIF\s*\(/i.test(currentTrimmed)) {
      const elseIfCondition = extractCondition(currentTrimmed, 'ELSEIF');
      const elseIfLine = i + 1;
      const elseIfResult = parseBlock(lines, i + 1, 'endif');
      elseIfClauses.push({ condition: elseIfCondition, body: elseIfResult.statements, line: elseIfLine });
      i = elseIfResult.nextIndex;
      continue;
    }

    if (currentUpper === 'ELSE;' || currentUpper === 'ELSE') {
      const elseResult = parseBlock(lines, i + 1, 'endif');
      elseBody = elseResult.statements;
      i = elseResult.nextIndex;
      continue;
    }

    // Should not reach here
    break;
  }

  // If we get here, ENDIF was not found
  throw new ParseError(lines.length, `Fehlendes ENDIF — IF-Block wurde nicht geschlossen`);
}

interface WhileParseResult {
  whileBlock: TiWhileBlock;
  nextIndex: number;
}

function parseWhileBlock(lines: string[], startIndex: number): WhileParseResult {
  const trimmed = lines[startIndex]!.trim();
  const lineNum = startIndex + 1;
  const condition = extractCondition(trimmed, 'WHILE');

  const bodyResult = parseBlock(lines, startIndex + 1, 'end');

  return {
    whileBlock: {
      type: 'while',
      condition,
      body: bodyResult.statements,
      line: lineNum,
    },
    nextIndex: bodyResult.nextIndex + 1, // skip past the END line
  };
}

/**
 * Extract the condition from an IF/ELSEIF/WHILE line.
 * E.g. "IF(x > 0);" => "x > 0"
 */
function extractCondition(line: string, keyword: string): string {
  // Remove the keyword prefix (case-insensitive)
  const afterKeyword = line.substring(keyword.length).trim();

  // Find matching parentheses
  if (!afterKeyword.startsWith('(')) {
    // Fallback: return everything after keyword, stripped of trailing semicolons
    return afterKeyword.replace(/;$/, '').trim();
  }

  let depth = 0;
  let endIdx = -1;
  for (let j = 0; j < afterKeyword.length; j++) {
    if (afterKeyword[j] === '(') depth++;
    if (afterKeyword[j] === ')') {
      depth--;
      if (depth === 0) {
        endIdx = j;
        break;
      }
    }
  }

  if (endIdx === -1) {
    return afterKeyword.replace(/;$/, '').trim();
  }

  // Return content inside the outermost parentheses
  return afterKeyword.substring(1, endIdx).trim();
}

/**
 * Try to parse a line as an assignment: `variable = expression;`
 */
function tryParseAssignment(line: string, lineNum: number): TiAssignment | null {
  // Match: identifier = expression;
  // The variable name can contain letters, digits, underscores
  // We need to be careful not to match == (comparison)
  const match = line.match(/^([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?\s*$/);
  if (!match) return null;

  const variable = match[1]!;
  const expression = match[2]!.trim();

  // Don't match lines that look like comparisons (==) or keywords
  const upperVar = variable.toUpperCase();
  if (['IF', 'ELSEIF', 'ELSE', 'ENDIF', 'WHILE', 'END'].includes(upperVar)) {
    return null;
  }

  const cellGetInfo = detectCellGet(expression);

  return {
    type: 'assignment',
    variable,
    expression,
    isExternal: cellGetInfo !== undefined,
    cellGetInfo,
    line: lineNum,
  };
}

/**
 * Detect CellGetN or CellGetS in an expression and extract params.
 */
function detectCellGet(expression: string): { fn: 'CellGetN' | 'CellGetS'; params: string[] } | undefined {
  const match = expression.match(/\b(CellGetN|CellGetS)\s*\(([^)]*)\)/i);
  if (!match) return undefined;

  const normalizedFn: 'CellGetN' | 'CellGetS' = match[1]!.toUpperCase().includes('GETN') ? 'CellGetN' : 'CellGetS';

  const paramsStr = match[2]!.trim();
  const params = paramsStr ? splitParams(paramsStr) : [];

  return { fn: normalizedFn, params };
}

/**
 * Split function parameters, respecting nested parentheses and string literals.
 */
function splitParams(paramsStr: string): string[] {
  const params: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < paramsStr.length; i++) {
    const ch = paramsStr[i];

    if (inString) {
      current += ch;
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }

    if (ch === ')') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    params.push(current.trim());
  }

  return params;
}

/**
 * Try to parse a line as a function call statement: `FunctionName(args...);`
 */
function tryParseFunctionCall(line: string, lineNum: number): TiFunctionCall | null {
  // Match function name at start
  const nameMatch = line.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!nameMatch) return null;

  const name = nameMatch[1]!;

  // Don't match IF/WHILE/ELSEIF as function calls
  const upperName = name.toUpperCase();
  if (['IF', 'ELSEIF', 'WHILE'].includes(upperName)) {
    return null;
  }

  // Find matching closing paren (handles nested parens)
  const argsStart = nameMatch[0].length;
  let depth = 1;
  let argsEnd = -1;
  for (let j = argsStart; j < line.length; j++) {
    if (line[j] === '(') depth++;
    if (line[j] === ')') {
      depth--;
      if (depth === 0) {
        argsEnd = j;
        break;
      }
    }
  }

  if (argsEnd === -1) return null;

  // Check that after the closing paren there's only optional semicolon and whitespace
  const remainder = line.substring(argsEnd + 1).trim();
  if (remainder !== '' && remainder !== ';') return null;

  const argsStr = line.substring(argsStart, argsEnd).trim();
  const args = argsStr ? splitParams(argsStr) : [];

  return {
    type: 'functionCall',
    name,
    args,
    line: lineNum,
  };
}

function hasTrailingEndif(line: string): boolean {
  const upper = line.toUpperCase();
  let inStr = false;
  for (let k = 0; k <= upper.length - 5; k++) {
    const ch = line[k] ?? '';
    if (ch === "'") { inStr = !inStr; continue; }
    if (inStr) { continue; }
    if (upper.slice(k, k + 5) === 'ENDIF') {
      const prev = k > 0 ? (line[k - 1] ?? '') : '';
      const next = k + 5 < line.length ? (line[k + 5] ?? '') : '';
      if (/\w/.test(prev) || /\w/.test(next)) { continue; }
      return true;
    }
  }
  return false;
}

function splitStatementsAtDepthZero(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let inStr = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (ch === "'") { inStr = !inStr; current += ch; continue; }
    if (!inStr) {
      if (ch === '(') { depth++; }
      else if (ch === ')') { depth--; }
      else if (ch === ';' && depth === 0) {
        if (current.trim()) { out.push(current.trim()); }
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) { out.push(current.trim()); }
  return out;
}

function parseInlineStatements(stmtTexts: string[], lineNum: number): TiStatement[] | null {
  const result: TiStatement[] = [];
  for (const raw of stmtTexts) {
    const s = raw.trim();
    if (!s) { continue; }
    const upper = s.toUpperCase();
    if (upper === 'ELSE' || upper === 'ELSE;' || upper.startsWith('ELSEIF')) { return null; }
    const withSemi = s.endsWith(';') ? s : s + ';';
    const a = tryParseAssignment(withSemi, lineNum);
    if (a) { result.push(a); continue; }
    const fc = tryParseFunctionCall(withSemi, lineNum);
    if (fc) { result.push(fc); continue; }
    const bk = tryParseBareKeyword(withSemi, lineNum);
    if (bk) { result.push(bk); continue; }
    return null;
  }
  return result;
}

function tryParseSingleLineIf(line: string, lineNum: number): TiIfBlock | null {
  const ifMatch = line.match(/^(IF\s*)\(/i);
  if (!ifMatch) { return null; }
  const openParen = ifMatch[1]!.length;

  let depth = 1;
  let inStr = false;
  let condEnd = -1;
  for (let j = openParen + 1; j < line.length; j++) {
    const ch = line[j];
    if (ch === "'") { inStr = !inStr; continue; }
    if (inStr) { continue; }
    if (ch === '(') { depth++; }
    else if (ch === ')') {
      depth--;
      if (depth === 0) { condEnd = j; break; }
    }
  }
  if (condEnd === -1) { return null; }

  const condition = line.substring(openParen + 1, condEnd).trim();
  let rest = line.substring(condEnd + 1).trim();
  if (rest.startsWith(';')) { rest = rest.substring(1).trim(); }

  const upperRest = rest.toUpperCase();
  let endifStart = -1;
  let inStr2 = false;
  for (let k = 0; k <= upperRest.length - 5; k++) {
    const ch = rest[k] ?? '';
    if (ch === "'") { inStr2 = !inStr2; continue; }
    if (inStr2) { continue; }
    if (upperRest.slice(k, k + 5) === 'ENDIF') {
      const prev = k > 0 ? (rest[k - 1] ?? '') : '';
      const next = k + 5 < rest.length ? (rest[k + 5] ?? '') : '';
      if (/\w/.test(prev) || /\w/.test(next)) { continue; }
      endifStart = k;
    }
  }
  if (endifStart === -1) { return null; }

  const bodyText = rest.substring(0, endifStart).trim();
  const stmts = splitStatementsAtDepthZero(bodyText);
  const thenBody = parseInlineStatements(stmts, lineNum);
  if (thenBody === null) { return null; }

  return {
    type: 'if',
    condition,
    thenBody,
    elseIfClauses: [],
    elseBody: [],
    line: lineNum,
  };
}

/** TI keywords that can appear as bare statements (without parentheses). */
const BARE_KEYWORDS = new Set([
  'itemskip', 'itemreject', 'processquit', 'processerror', 'processbreak',
  'processabort',
]);

/**
 * Try to parse a bare keyword like `ItemSkip;` (no parentheses).
 * These are TI process control statements that don't require arguments.
 */
function tryParseBareKeyword(line: string, lineNum: number): TiFunctionCall | null {
  const cleaned = line.endsWith(';') ? line.slice(0, -1).trim() : line.trim();
  if (BARE_KEYWORDS.has(cleaned.toLowerCase())) {
    return { type: 'functionCall', name: cleaned, args: [], line: lineNum };
  }
  return null;
}
