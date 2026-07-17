/**
 * Per-process variable environment.
 *
 * Classifies each assignment `var = expression;` as
 *   - literal    (string literal or numeric literal)
 *   - param      (reference to a process parameter, directly or via another local variable that is a param)
 *   - datasource (reference to a DataSource variable whose value comes from the source data at runtime)
 *   - dynamic    (everything else — CellGet, concatenation, function calls, IF, loops)
 *
 * Multi-assignment (a variable is assigned different values) → dynamic,
 * because the value is no longer unambiguous at any given call site.
 */

export type TiVarType = 'Numeric' | 'String';

export type VarBinding =
  | { kind: 'literal'; value: string }                                               // resolved literal value (string content without quotes, or numeric text)
  | { kind: 'param'; paramName: string; paramType?: TiVarType | undefined }           // value comes directly from a process parameter
  | { kind: 'datasource'; varName: string; varType: TiVarType }                      // value comes from a DataSource variable (one per processed row)
  | { kind: 'dynamic' };                                                             // cannot resolve (computed/IF/CellGet/concat/etc.)

export interface ProcessEnv {
  /** Parameter names of this process (lowercase). */
  paramsLc: Set<string>;
  /** Original-cased param names (for display). Map from lowercase → original. */
  paramOriginal: Map<string, string>;
  /** Parameter types (lowercase name → type). */
  paramTypes: Map<string, TiVarType>;
  /** DataSource variable names (lowercase → type + original casing). */
  datasourceVars: Map<string, { name: string; type: TiVarType }>;
  /** Local variable bindings (varname lowercase → resolved binding). */
  vars: Map<string, VarBinding>;
}

const STRING_LITERAL_RE = /^'([^']*)'$/;
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

function neutralizeLine(line: string): string {
  return line
    .replace(/'[^']*'/g, s => ' '.repeat(s.length))
    .replace(/#.*$/, '');
}

const SECTION_MARKER_RE = /^57[2345],\d*$/;

/**
 * Split an expression on top-level '|' (TI string-concat), ignoring '|' inside
 * 'string literals' or (parens). A single-element result means no top-level '|'
 * was found (not a concatenation).
 */
function splitTopLevelConcat(expr: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  for (const ch of expr) {
    if (ch === "'") { inStr = !inStr; cur += ch; }
    else if (!inStr && ch === '(') { depth++; cur += ch; }
    else if (!inStr && ch === ')') { depth--; cur += ch; }
    else if (!inStr && depth === 0 && ch === '|') { parts.push(cur); cur = ''; }
    else { cur += ch; }
  }
  parts.push(cur);
  return parts;
}

/**
 * Classify a single right-hand-side expression (no surrounding whitespace).
 * Only handles simple cases:
 *   'literal', 42, varName (→ lookup), paramName (→ param-ref), dsVarName (→ datasource-ref).
 * Everything else (function calls, concatenation `||`/`|`, arithmetic, IF, brackets) → dynamic.
 */
export function resolveExpression(expr: string, env: ProcessEnv): VarBinding {
  const e = expr.trim().replace(/;+$/, '').trim();

  // String literal
  const strM = STRING_LITERAL_RE.exec(e);
  if (strM) { return { kind: 'literal', value: strM[1]! }; }

  // Numeric literal
  if (NUMERIC_LITERAL_RE.test(e)) { return { kind: 'literal', value: e }; }

  // Bare identifier — could be param, a DataSource var, or a previously-assigned local var
  if (IDENTIFIER_RE.test(e)) {
    const lc = e.toLowerCase();
    if (env.paramsLc.has(lc)) {
      return {
        kind: 'param',
        paramName: env.paramOriginal.get(lc) ?? e,
        paramType: env.paramTypes.get(lc),
      };
    }
    const ds = env.datasourceVars.get(lc);
    if (ds) {
      return { kind: 'datasource', varName: ds.name, varType: ds.type };
    }
    const bound = env.vars.get(lc);
    if (bound) { return bound; }
    // Unknown identifier — treat as dynamic (could be a global, a later-assigned var, etc.)
    return { kind: 'dynamic' };
  }

  // Constant string-concatenation: fold if every operand resolves to a literal.
  const parts = splitTopLevelConcat(e);
  if (parts.length >= 2) {
    const values: string[] = [];
    for (const part of parts) {
      const resolved = resolveExpression(part, env);
      if (resolved.kind !== 'literal') { return { kind: 'dynamic' }; }
      values.push(resolved.value);
    }
    return { kind: 'literal', value: values.join('') };
  }

  return { kind: 'dynamic' };
}

export interface BuildEnvOptions {
  /** 0-basierte, exklusive Zeilen-Obergrenze — Env wird nur aus Zeilen `< stopAtLine` gebaut. */
  stopAtLine?: number;
  /** Typ-Informationen pro Parameter (Key: lowercase Name). */
  paramTypes?: Map<string, TiVarType>;
  /** DataSource-Variablen-Definitionen (kommen aus dem Process-Objekt). */
  datasourceVars?: Array<{ name: string; type: TiVarType }>;
  /**
   * true: Mehrfach-Zuweisungen überschreiben (letzte Zuweisung gewinnt) — für Hover/Resolver-View,
   * wo der User den aktuellen Stand an einer bestimmten Zeile sehen will.
   * false (Default): Mehrfach-Zuweisungen mit unterschiedlichen Bindungen werden zu `dynamic` demoted —
   * konservative Variante für Cross-Process-Referenztracking.
   */
  lastAssignmentWins?: boolean;
  /**
   * true: Flow-sensitive Auswertung (IF/ELSEIF/ELSE-Blöcke strukturell behandeln; siehe `flowSensitiveEnv.ts`).
   * Nur sinnvoll in Kombination mit `lastAssignmentWins:true`. Bei Parse-Fehlern wird transparent
   * auf den flow-insensitiven Pfad zurückgefallen.
   */
  flowSensitive?: boolean;
}

/**
 * Build a process env from TI text and the process's parameter names.
 * Processes assignments top-down; multi-assignments are demoted to dynamic.
 *
 * Overloads:
 *   buildProcessEnv(text, paramNames)
 *   buildProcessEnv(text, paramNames, stopAtLine)     — legacy positional
 *   buildProcessEnv(text, paramNames, options)
 */
export function buildProcessEnv(
  text: string,
  paramNames: string[],
  stopAtLineOrOptions?: number | BuildEnvOptions,
): ProcessEnv {
  const opts: BuildEnvOptions =
    typeof stopAtLineOrOptions === 'number'
      ? { stopAtLine: stopAtLineOrOptions }
      : (stopAtLineOrOptions ?? {});

  const paramsLc = new Set(paramNames.map(p => p.toLowerCase()));
  const paramOriginal = new Map(paramNames.map(p => [p.toLowerCase(), p] as const));
  const paramTypes = opts.paramTypes ?? new Map<string, TiVarType>();
  const datasourceVars = new Map<string, { name: string; type: TiVarType }>();
  for (const dv of opts.datasourceVars ?? []) {
    datasourceVars.set(dv.name.toLowerCase(), { name: dv.name, type: dv.type });
  }

  const env: ProcessEnv = { paramsLc, paramOriginal, paramTypes, datasourceVars, vars: new Map() };

  const assignedOnce = new Map<string, VarBinding>();
  const seen = new Set<string>();

  const assignRe = /^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*;?\s*(?:#.*)?$/;
  const lines = text.split('\n');
  const limit = opts.stopAtLine !== undefined ? Math.min(opts.stopAtLine, lines.length) : lines.length;

  for (let i = 0; i < limit; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/\r$/, '');
    if (SECTION_MARKER_RE.test(line.trim()) || line.trim() === '') { continue; }

    // Skip comment-only lines
    if (neutralizeLine(line).trim() === '') { continue; }

    // Skip if line does not look like a pure assignment (contains `==` or similar comparisons in condition context)
    const m = assignRe.exec(line);
    if (!m) { continue; }
    const varName = m[1]!;
    const rhs = m[2]!;

    // Exclude cases where rhs starts with `=` (meaning `==` comparison) — already filtered by regex `=\s*(.+)` non-greedy
    // but `a == b` would match with varName='a' and rhs='= b'. Guard:
    if (rhs.startsWith('=')) { continue; }

    const lc = varName.toLowerCase();
    // Never shadow a param name as a local var — a param reference of itself stays a param
    if (paramsLc.has(lc)) { continue; }
    // DataSource-Vars bleiben als solche erhalten — lokale Zuweisung mit demselben Namen wäre unüblich,
    // wir ignorieren sie um die „Herkunft aus der DataSource" sichtbar zu halten.
    if (datasourceVars.has(lc)) { continue; }

    const binding = resolveExpression(rhs, env);

    if (opts.lastAssignmentWins) {
      // Jüngste Zuweisung überschreibt — passt zur Sicht „Wert direkt vor Zeile N".
      assignedOnce.set(lc, binding);
      env.vars.set(lc, binding);
    } else if (seen.has(lc)) {
      const prev = assignedOnce.get(lc);
      if (prev && !bindingsEqual(prev, binding)) {
        // Konservativ: Multi-Assign mit unterschiedlichen Bindungen → dynamic.
        assignedOnce.set(lc, { kind: 'dynamic' });
        env.vars.set(lc, { kind: 'dynamic' });
      }
      // else: identische Bindung, Zustand bleibt
    } else {
      seen.add(lc);
      assignedOnce.set(lc, binding);
      env.vars.set(lc, binding);
    }
  }

  return env;
}

export function bindingsEqual(a: VarBinding, b: VarBinding): boolean {
  if (a.kind !== b.kind) { return false; }
  if (a.kind === 'literal'    && b.kind === 'literal')    { return a.value === b.value; }
  if (a.kind === 'param'      && b.kind === 'param')      { return a.paramName.toLowerCase() === b.paramName.toLowerCase(); }
  if (a.kind === 'datasource' && b.kind === 'datasource') { return a.varName.toLowerCase() === b.varName.toLowerCase(); }
  return a.kind === 'dynamic';
}
