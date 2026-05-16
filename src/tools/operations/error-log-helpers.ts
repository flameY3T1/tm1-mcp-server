const TS_RE = /(\d{14})/;

/**
 * Match a TI error log filename against a process name.
 *
 * Handles TM1 filename conventions:
 *   - Modern with session hash:  TM1ProcessError_<ts>_<id>_<proc>_<hash>.log  → `_<proc>_` contained
 *   - Modern without hash:       TM1ProcessError_<ts>_<id>_<proc>.log         → ends with `_<proc>.log`
 *   - Legacy/manual:             <proc>_<ts>.log                              → starts with `<proc>_`
 *   - Bare:                      <proc>                                       → exact match
 *
 * Substring-based match accepts a theoretical false positive when one process
 * name is delimited by underscores inside another (e.g. "Import" vs "Re_Import_X").
 * Acceptable trade for correctness on real-world v11 filenames.
 */
export function matchesProcessName(filename: string, processName: string): boolean {
  const f = filename.toLowerCase();
  const p = processName.toLowerCase();
  return (
    f === p ||
    f.startsWith(`${p}_`) ||
    f.endsWith(`_${p}.log`) ||
    f.includes(`_${p}_`)
  );
}

export function tsFromFilename(filename: string): number | null {
  const m = filename.match(TS_RE);
  if (!m) return null;
  const s = m[1]!;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  const ms = Date.UTC(y, mo, d, h, mi, se);
  return Number.isFinite(ms) ? ms : null;
}

export function truncateTail(content: string, maxBytes: number): { body: string; truncated: boolean } {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= maxBytes) return { body: content, truncated: false };
  return {
    body: Buffer.from(content, "utf8").subarray(-maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function tailLines(content: string, n: number): { body: string; truncated: boolean; totalLines: number } {
  const trimmed = content.replace(/[\r\n]+$/, "");
  const lines = trimmed.split(/\r?\n/);
  if (lines.length <= n) return { body: trimmed, truncated: false, totalLines: lines.length };
  return { body: lines.slice(-n).join("\n"), truncated: true, totalLines: lines.length };
}
