/**
 * Bracket-list parser for TM1 rules / feeders.
 *
 * Handles both syntactic forms found in real cube rules:
 *  - **Qualified**:  `['Dim':'Elem']`, `['Dim':{'E1','E2'}]`
 *  - **Positional** (most common in feeders): `['Elem1','Elem2','Elem3']`
 *  - **Mixed**:  `['Year':'2026', 'Sales']`
 *
 * Why a new parser instead of `parseBracketDimRefs` in rulesLinter.ts:
 * the existing one only matches the `'Dim':'Elem'` regex form and silently
 * skips bare positional element lists, which dominate real feeder code
 * (probe on 2026-05-18 found 92 / 125 feeder lines miss the existing parser).
 *
 * String escaping follows TM1 SQL-style: a literal single quote is written
 * as two consecutive single quotes (`'It''s'` → `It's`).
 */

export interface BracketEntry {
  /** Set when the entry is qualified (`'Dim':...`). */
  dim?: string;
  /** Single-element value (positional or `'Dim':'Elem'`). */
  elem?: string;
  /** Multi-element set: `'Dim':{'E1','E2'}`. */
  elems?: string[];
}

export interface BracketList {
  entries: BracketEntry[];
  /** True iff every entry is unqualified (`{ elem }` only). Empty bracket = true. */
  isPositional: boolean;
  /** True iff entries contain both qualified and positional forms. */
  isMixed: boolean;
  /** Byte offsets in the source line — useful for diagnostic messages. */
  startIndex: number;
  endIndex: number;
}

function readQuotedString(
  src: string,
  i: number,
): { value: string; next: number } | null {
  if (src[i] !== "'") return null;
  let j = i + 1;
  let out = "";
  while (j < src.length) {
    const c = src[j]!;
    if (c === "'") {
      if (src[j + 1] === "'") {
        out += "'";
        j += 2;
        continue;
      }
      return { value: out, next: j + 1 };
    }
    out += c;
    j++;
  }
  return null;
}

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i]!)) i++;
  return i;
}

function readSet(
  src: string,
  i: number,
): { values: string[]; next: number } | null {
  if (src[i] !== "{") return null;
  let j = i + 1;
  const values: string[] = [];
  while (j < src.length) {
    j = skipWs(src, j);
    if (src[j] === "}") return { values, next: j + 1 };
    const s = readQuotedString(src, j);
    if (!s) return null;
    values.push(s.value);
    j = skipWs(src, s.next);
    if (src[j] === ",") {
      j++;
      continue;
    }
    if (src[j] === "}") return { values, next: j + 1 };
    return null;
  }
  return null;
}

function readEntry(
  src: string,
  i: number,
): { entry: BracketEntry; next: number } | null {
  const first = readQuotedString(src, i);
  if (!first) return null;
  let j = skipWs(src, first.next);
  if (src[j] === ":") {
    j = skipWs(src, j + 1);
    if (src[j] === "{") {
      const set = readSet(src, j);
      if (!set) return null;
      return { entry: { dim: first.value, elems: set.values }, next: set.next };
    }
    const rhs = readQuotedString(src, j);
    if (!rhs) return null;
    return { entry: { dim: first.value, elem: rhs.value }, next: rhs.next };
  }
  return { entry: { elem: first.value }, next: first.next };
}

function parseBracketAt(
  src: string,
  start: number,
): { list: BracketList; next: number } | null {
  if (src[start] !== "[") return null;
  const entries: BracketEntry[] = [];
  let j = skipWs(src, start + 1);
  if (src[j] === "]") {
    return {
      list: {
        entries,
        isPositional: true,
        isMixed: false,
        startIndex: start,
        endIndex: j,
      },
      next: j + 1,
    };
  }
  while (j < src.length) {
    const e = readEntry(src, j);
    if (!e) return null;
    entries.push(e.entry);
    j = skipWs(src, e.next);
    if (src[j] === ",") {
      j = skipWs(src, j + 1);
      continue;
    }
    if (src[j] === "]") {
      let qualifiedCount = 0;
      let positionalCount = 0;
      for (const en of entries) {
        if (en.dim !== undefined) qualifiedCount++;
        else positionalCount++;
      }
      const isPositional = qualifiedCount === 0;
      const isMixed = qualifiedCount > 0 && positionalCount > 0;
      return {
        list: {
          entries,
          isPositional,
          isMixed,
          startIndex: start,
          endIndex: j,
        },
        next: j + 1,
      };
    }
    return null;
  }
  return null;
}

/**
 * Parse the first complete `[...]` list found in `text`. Returns `null` if
 * no opening bracket exists outside string literals or the bracket is
 * malformed / unterminated.
 */
export function parseBracketList(text: string): BracketList | null {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'") {
      const s = readQuotedString(text, i);
      if (!s) return null;
      i = s.next;
      continue;
    }
    if (c === "[") {
      const r = parseBracketAt(text, i);
      return r ? r.list : null;
    }
    i++;
  }
  return null;
}

/**
 * Scan `line` for every complete top-level `[...]` list and return them in
 * source order. Brackets inside single-quoted string literals are ignored.
 * Malformed lists are skipped silently — extraction is best-effort.
 */
export function extractBracketLists(line: string): BracketList[] {
  const out: BracketList[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") {
      const s = readQuotedString(line, i);
      if (!s) break;
      i = s.next;
      continue;
    }
    if (c === "[") {
      const r = parseBracketAt(line, i);
      if (r) {
        out.push(r.list);
        i = r.next;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}
