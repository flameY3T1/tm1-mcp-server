// Pure helpers for tm1_get_process_code's stripComments mode. No I/O.
//
// TM1 TI code uses only `#` line comments (no block comments); `#` starts a
// comment that runs to end of line. Grown models accumulate large blocks of
// commented-out dead code that waste an agent's context. These helpers collapse
// long runs of full-line comments and report comment density for discoverability.

/** A full-line comment is a line that is only a comment (optional indent + `#`). */
const isFullCommentLine = (line: string): boolean => /^\s*#/.test(line);

/** Runs of this many or more consecutive full-comment lines are collapsed. */
export const COLLAPSE_MIN = 4;

export interface CommentStats {
  totalLines: number;
  commentLines: number;
}

/** Count total lines and full-line comments (non-destructive). */
export function commentStats(src: string): CommentStats {
  if (src === "") return { totalLines: 0, commentLines: 0 };
  const lines = src.split(/\r?\n/);
  let commentLines = 0;
  for (const line of lines) {
    if (isFullCommentLine(line)) commentLines++;
  }
  return { totalLines: lines.length, commentLines };
}

export interface StripResult {
  code: string;
  /** Original comment lines removed (sum of collapsed run lengths). */
  removedLines: number;
  /** Number of collapsed blocks. */
  collapsedBlocks: number;
}

/**
 * Collapse runs of >= COLLAPSE_MIN consecutive full-line comments into a single
 * `# [... N lines commented out ...]` marker. Shorter comment runs and inline
 * trailing comments are kept verbatim (they are usually documentation, not dead
 * code). Line endings are normalized to `\n` (read-only display).
 */
export function stripCommentBlocks(src: string, minRun = COLLAPSE_MIN): StripResult {
  if (src === "") return { code: "", removedLines: 0, collapsedBlocks: 0 };
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let removedLines = 0;
  let collapsedBlocks = 0;

  let i = 0;
  while (i < lines.length) {
    if (isFullCommentLine(lines[i]!)) {
      let j = i;
      while (j < lines.length && isFullCommentLine(lines[j]!)) j++;
      const runLength = j - i;
      if (runLength >= minRun) {
        out.push(`# [... ${runLength} lines commented out ...]`);
        removedLines += runLength;
        collapsedBlocks++;
      } else {
        for (let k = i; k < j; k++) out.push(lines[k]!);
      }
      i = j;
    } else {
      out.push(lines[i]!);
      i++;
    }
  }

  return { code: out.join("\n"), removedLines, collapsedBlocks };
}
