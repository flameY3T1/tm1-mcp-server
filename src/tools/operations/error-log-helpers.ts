const TS_RE = /(\d{14})/;

export function tsFromFilename(filename: string): number | null {
  const m = filename.match(TS_RE);
  if (!m) return null;
  const s = m[1];
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
