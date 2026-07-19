// MDX identifier helpers.
//
// A bracketed MDX identifier (`[Dimension].[Element]`) is terminated by the
// first unescaped `]`. A name that itself contains `]` (e.g. `Q4]Adj`) must
// therefore double it (`]` → `]]`), otherwise the identifier is closed early
// and the query silently addresses the wrong member (MDX injection /
// mis-addressed cell). Every name that goes into a bracketed identifier —
// dimension, hierarchy, element, cube — must be escaped exactly once.

/** Escape `]` → `]]` in an MDX bracketed-identifier name component. */
export function escapeMdxName(s: string): string {
  return s.replace(/]/g, "]]");
}
