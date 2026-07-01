import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, pageResponse, wrappedPageResponse, type Column } from "../format.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

// Best-effort extraction of {process, ts} from an error-log filename.
// Two known patterns (see server-service.listErrorLogFiles):
//   modern v11: TM1ProcessError_<ts>_<id>_<proc>(_<hash>)?.log
//   legacy:     <proc>_<ts>.log
// Process names may contain underscores, so the modern parse greedily captures
// the tail and strips a trailing session-hash token (_<hex6+>). This is a
// heuristic — good enough for audit triage, not a guaranteed exact split.
export function parseLogName(filename: string): { process: string | null; ts: string | null } {
  const modern = filename.match(/^TM1ProcessError_(\d{14})_\d+_(.+)\.log$/i);
  if (modern) {
    // Strip the trailing TM1 session-hash token. Real-world v11 hashes are
    // lowercase base36 (e.g. "_mp2su7f4sybb"), not just hex, so match any
    // lowercase-alphanumeric token of length >= 8 that contains at least one
    // digit (the digit requirement avoids stripping real word suffixes like
    // "_export"). Collapses TIRecord_<proc>_<hash> variants onto one process.
    const proc = modern[2]!.replace(/_(?=[a-z0-9]*\d)[a-z0-9]{8,}$/, "");
    return { ts: modern[1]!, process: proc };
  }
  const legacy = filename.match(/^(.+)_(\d{8,14})\.log$/i);
  if (legacy) {
    return { ts: legacy[2]!, process: legacy[1]! };
  }
  return { process: null, ts: null };
}

// "20260615123045" → "2026-06-15T12:30:45" (best-effort; shorter ts left as-is).
export function formatTs(ts: string | null): string | null {
  if (!ts || ts.length < 8) return null;
  const y = ts.slice(0, 4);
  const mo = ts.slice(4, 6);
  const d = ts.slice(6, 8);
  const h = ts.slice(8, 10) || "00";
  const mi = ts.slice(10, 12) || "00";
  const s = ts.slice(12, 14) || "00";
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

// Whole-day count between two 14-digit timestamps, inclusive (min 1).
export function spanDays(firstTs: string, lastTs: string): number {
  const toDate = (ts: string) => {
    const iso = formatTs(ts);
    return iso ? new Date(iso) : null;
  };
  const a = toDate(firstTs);
  const b = toDate(lastTs);
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  const diffDays = Math.floor((b.getTime() - a.getTime()) / 86_400_000);
  return Math.max(1, diffDays + 1);
}

interface ErrorGroup {
  process: string;
  count: number;
  firstSeen: string | null;
  lastSeen: string | null;
  spanDays: number;
  perDay: number;
}

export function registerListErrorLogs(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_error_logs",
    [
      "List TI process error log files on the TM1 server, newest first. Paginated (default 50/page).",
      "For one-call diagnosis of a failed process prefer tm1_diagnose_process_error (list + fetch combined); use this to browse the catalogue, then tm1_get_error_log_content for raw text.",
      "groupBy='process' returns a per-process audit summary instead of individual files.",
    ].join(" "),
    {
      processName: z.string().optional()
        .describe("Optional process-name filter — matches both modern v11 'TM1ProcessError_<ts>_<id>_<processName>_<hash>.log' and legacy '<processName>_<ts>.log' filename patterns."),
      since: z.string().optional()
        .describe("Only logs with LastUpdated >= this ISO timestamp, e.g. '2026-05-01T00:00:00'"),
      groupBy: z
        .literal("process")
        .optional()
        .describe(
          "Set to 'process' for an aggregated audit summary instead of individual files: " +
          "per process {count, firstSeen, lastSeen, spanDays, perDay}, sorted by count desc. " +
          "Answers 'which processes fail regularly' in one call. Process name is extracted from the " +
          "filename heuristically; unparseable names bucket under '(unparsed)'.",
        ),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({ processName, since, groupBy, limit, offset, fetchAll, format }) => {
      // Pull a generous slice from the server (top=500); pagination is applied client-side
      // so callers always see total + has_more even if they limit to a small page.
      const files = await tm1Client.server.listErrorLogFiles({ processName, since, top: 500 });

      if (groupBy === "process") {
        const acc = new Map<string, { count: number; first: string | null; last: string | null }>();
        for (const f of files) {
          const { process, ts } = parseLogName(f.filename);
          const key = process ?? "(unparsed)";
          let g = acc.get(key);
          if (!g) {
            g = { count: 0, first: null, last: null };
            acc.set(key, g);
          }
          g.count++;
          if (ts) {
            if (g.first === null || ts < g.first) g.first = ts;
            if (g.last === null || ts > g.last) g.last = ts;
          }
        }
        const allGroups: ErrorGroup[] = [...acc.entries()]
          .map(([process, g]) => {
            const span = g.first && g.last ? spanDays(g.first, g.last) : 1;
            return {
              process,
              count: g.count,
              firstSeen: formatTs(g.first),
              lastSeen: formatTs(g.last),
              spanDays: span,
              perDay: Math.round((g.count / span) * 100) / 100,
            };
          })
          .sort((a, b) => b.count - a.count || a.process.localeCompare(b.process));
        const groupPage = paginate(allGroups, limit, offset, fetchAll);
        const wrapper = {
          groupBy: "process",
          processName,
          since,
          totalFiles: files.length,
          groupCount: allGroups.length,
          ...groupPage,
        };
        const groupColumns: Column<ErrorGroup>[] = [
          { header: "process", get: (g) => g.process },
          { header: "count", get: (g) => g.count },
          { header: "firstSeen", get: (g) => g.firstSeen ?? "" },
          { header: "lastSeen", get: (g) => g.lastSeen ?? "" },
          { header: "spanDays", get: (g) => g.spanDays },
          { header: "perDay", get: (g) => g.perDay },
        ];
        return wrappedPageResponse(wrapper, groupPage, format, {
          title: "Error log summary (by process)",
          columns: groupColumns,
        });
      }

      const page = paginate(files, limit, offset, fetchAll);
      type Row = (typeof files)[number];
      const columns: Column<Row>[] = [
        { header: "filename", get: (f) => f.filename },
        // v11 OData exposes no LastUpdated on this entity; derive it from the
        // timestamp embedded in the filename so the column is not always empty.
        { header: "lastUpdated", get: (f) => f.lastUpdated ?? formatTs(parseLogName(f.filename).ts) ?? "" },
      ];
      return pageResponse(page, format, { title: "Error logs", columns });
    },
  );
}
