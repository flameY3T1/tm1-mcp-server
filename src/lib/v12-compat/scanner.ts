// Line-oriented scanner that finds deprecated-in-v12 TI function calls inside
// a code block (a TI section body or rules text). Strips '#'-prefixed full-line
// comments before matching; inline comments are uncommon in TI but accepted as
// a small false-positive surface in exchange for simplicity.
import { V12_DEPRECATED_TI, V12_DEPRECATED_TI_REGEX } from "./deprecated-ti.js";

export interface ScanHit {
  line: number;          // 1-based line number
  function: string;      // original casing from the canonical list
  snippet: string;       // trimmed source line, truncated to 200 chars
  severity: "error" | "warning";
  issue: string;
  suggestion: string;
}

const SNIPPET_MAX = 200;

export function scanForDeprecatedTi(text: string): ScanHit[] {
  if (!text) return [];
  const hits: ScanHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("#")) continue;
    const seenOnThisLine = new Set<string>();
    V12_DEPRECATED_TI_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = V12_DEPRECATED_TI_REGEX.exec(raw)) !== null) {
      const key = m[1]!.toLowerCase();
      if (seenOnThisLine.has(key)) continue;
      seenOnThisLine.add(key);
      const entry = V12_DEPRECATED_TI.get(key);
      if (!entry) continue;
      const snippet = raw.trim();
      hits.push({
        line: i + 1,
        function: entry.name,
        snippet: snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX) + "…" : snippet,
        severity: entry.severity,
        issue: entry.issue,
        suggestion: entry.suggestion,
      });
    }
  }
  return hits;
}
