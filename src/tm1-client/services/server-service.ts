// Server domain service. Owns server-level read endpoints — configuration,
// message log, transaction log, error-log files. Stateless wrappers; nothing
// here mutates server state.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  AuditLogDetail,
  AuditLogEntry,
  CellValue,
  ErrorLogFile,
  MessageLogEntry,
  ServerInfo,
  TransactionLogEntry,
} from "../../types.js";
import type { TM1HttpClient } from "../http.js";

// The TransactionLogEntries endpoint scans the whole log server-side and is
// slow; without log-read rights it can hang until the global request timeout.
// Before the real (orderby + filtered) query we fire a bare `$top=1` probe —
// NO $orderby, NO $filter, so TM1 can stop after the first row and the result
// is at most one entry — bounded by a short timeout to fail fast.
const TXLOG_PROBE_TIMEOUT_MS = 8000;
// Per-window query timeout. Each windowed/bounded query runs once (no retry),
// so a timeout means the range is too large/dense — not a transient blip.
const TXLOG_QUERY_TIMEOUT_MS = 20000;
// Expanding lookback windows (ms) for the no-`since` adaptive backfill. We walk
// backward from the anchor, widening until `top` rows are collected or the last
// window is exhausted — so an open-ended call never triggers a full-log scan.
const TXLOG_BACKFILL_WINDOWS_MS = [
  10 * 60_000, // 10 min
  60 * 60_000, // 1 h
  6 * 3_600_000, // 6 h
  24 * 3_600_000, // 1 d
  3 * 86_400_000, // 3 d
  7 * 86_400_000, // 7 d
  30 * 86_400_000, // 30 d
  90 * 86_400_000, // 90 d
  365 * 86_400_000, // 1 y
];

// Format an epoch-ms instant as an OData UTC literal (second precision, no ms).
function epochToOData(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Normalize a user timestamp into an OData v4 DateTimeOffset literal for a
 * TM1 $filter. TM1 rejects a bare `2026-06-08T00:00:00` ("Syntax error … near
 * -06") — the value MUST carry a timezone. Verified against TM1 11.8: only the
 * `Z`-suffixed (or ±hh:mm-offset) form parses. Date-only input expands to
 * start-of-day UTC; a zoneless datetime gets a `Z`; an already-zoned value is
 * left untouched.
 */
export function toOdataDateTime(input: string): string {
  let t = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t = `${t}T00:00:00`;
  if (!/[zZ]$/.test(t) && !/[+-]\d{2}:\d{2}$/.test(t)) t = `${t}Z`;
  return t;
}

const enc = encodeURIComponent;

export class ServerService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Fetch TM1 server configuration. Merges /Configuration and
   * /ActiveConfiguration; tolerates ActiveConfiguration being absent on
   * older builds.
   */
  async getInfo(): Promise<ServerInfo> {
    const cfg = await this.http.request<Record<string, unknown>>("GET", "/api/v1/Configuration");
    let active: Record<string, unknown> = {};
    try {
      active = await this.http.request<Record<string, unknown>>("GET", "/api/v1/ActiveConfiguration");
    } catch {
      // Some TM1 versions don't expose ActiveConfiguration — ignore.
    }
    const merged: Record<string, unknown> = { ...cfg, ...active };
    delete merged["@odata.context"];
    return {
      serverName: String(merged.ServerName ?? ""),
      productVersion: String(merged.ProductVersion ?? ""),
      productEdition: merged.ProductEdition !== undefined ? String(merged.ProductEdition) : undefined,
      adminHost: merged.AdminHost !== undefined ? String(merged.AdminHost) : undefined,
      dataDirectory: merged.DataBaseDirectory !== undefined ? String(merged.DataBaseDirectory) : undefined,
      timeZoneId: merged.TimeZoneID !== undefined ? String(merged.TimeZoneID) : undefined,
      integratedSecurityMode: merged.IntegratedSecurityMode !== undefined ? String(merged.IntegratedSecurityMode) : undefined,
      extra: merged,
    };
  }

  /**
   * Get recent TM1 server message log entries (newest first).
   * GET /api/v1/MessageLogEntries?$orderby=TimeStamp desc&$top={top}
   */
  async getMessageLog(top = 100): Promise<MessageLogEntry[]> {
    const path = `/api/v1/MessageLogEntries?$orderby=TimeStamp desc&$top=${top}`;
    const response = await this.http.request<{
      value: Array<{ TimeStamp?: string; Timestamp?: string; Level?: string; Message?: string; Text?: string }>;
    }>("GET", path);
    return response.value.map((e) => ({
      timestamp: e.TimeStamp ?? e.Timestamp ?? "",
      level: (e.Level ?? "").toUpperCase(),
      message: e.Message ?? e.Text ?? "",
    }));
  }

  /**
   * Fetch recent TM1 audit log entries (metadata/security changes), newest
   * first. Requires AuditLogOn=T in tm1s.cfg — with auditing disabled the
   * entity set is empty.
   * GET /api/v1/AuditLogEntries
   */
  async getAuditLog(opts: {
    top?: number | undefined;
    user?: string | undefined;
    objectType?: string | undefined;
    objectName?: string | undefined;
    since?: string | undefined; // ISO timestamp
    until?: string | undefined; // ISO timestamp
    includeDetails?: boolean | undefined;
  }): Promise<AuditLogEntry[]> {
    const esc = (s: string): string => s.replace(/'/g, "''");
    const filters: string[] = [];
    if (opts.user) filters.push(`UserName eq '${esc(opts.user)}'`);
    if (opts.objectType) filters.push(`ObjectType eq '${esc(opts.objectType)}'`);
    if (opts.objectName) filters.push(`ObjectName eq '${esc(opts.objectName)}'`);
    if (opts.since) filters.push(`TimeStamp ge ${opts.since}`);
    if (opts.until) filters.push(`TimeStamp le ${opts.until}`);

    const top = opts.top ?? 100;
    const qs: string[] = [`$top=${top}`, `$orderby=${enc("TimeStamp desc")}`];
    if (filters.length > 0) qs.push(`$filter=${enc(filters.join(" and "))}`);
    if (opts.includeDetails) qs.push("$expand=AuditDetails");

    type RawDetail = {
      ID?: number;
      TimeStamp?: string;
      UserName?: string;
      Description?: string;
      ObjectType?: string;
      ObjectName?: string;
    };
    type RawEntry = RawDetail & { AuditDetails?: RawDetail[] };

    const response = await this.http.request<{ value: RawEntry[] }>(
      "GET",
      `/api/v1/AuditLogEntries?${qs.join("&")}`,
    );

    const mapDetail = (d: RawDetail): AuditLogDetail => ({
      id: d.ID ?? 0,
      timestamp: d.TimeStamp ?? "",
      user: d.UserName ?? "",
      description: d.Description ?? "",
      objectType: d.ObjectType ?? "",
      objectName: d.ObjectName ?? "",
    });

    return response.value.map((e): AuditLogEntry => {
      const entry: AuditLogEntry = mapDetail(e);
      if (e.AuditDetails !== undefined) entry.details = e.AuditDetails.map(mapDetail);
      return entry;
    });
  }

  /**
   * Fetch recent TM1 transaction log entries (cell writes).
   * GET /api/v1/TransactionLogEntries
   */
  async getTransactionLog(opts: {
    top?: number | undefined;
    cubeName?: string | undefined;
    user?: string | undefined;
    since?: string | undefined; // ISO timestamp (lower bound)
    until?: string | undefined; // ISO timestamp (upper bound)
  }): Promise<TransactionLogEntry[]> {
    const top = opts.top ?? 100;

    // Preflight: bare $top=1 (no orderby/filter) — cheap reachability/permission
    // gate that fails fast instead of hanging.
    await this.probeTransactionLog();

    // Explicit lower bound → a single bounded query [since, until].
    if (opts.since !== undefined) {
      return this.queryTransactionLog({
        top,
        cubeName: opts.cubeName,
        user: opts.user,
        since: opts.since,
        until: opts.until,
      });
    }

    // No lower bound → adaptive backward windowing from `until` (or now). An
    // unbounded TransactionLogEntries scan takes minutes-to-hours; instead we
    // probe expanding windows and stop as soon as we have `top` rows. If a wide
    // window times out we keep the rows already collected rather than failing.
    const anchorMs =
      opts.until !== undefined ? Date.parse(toOdataDateTime(opts.until)) : Date.now();
    let collected: TransactionLogEntry[] = [];
    for (const windowMs of TXLOG_BACKFILL_WINDOWS_MS) {
      let entries: TransactionLogEntry[];
      try {
        entries = await this.queryTransactionLog({
          top,
          cubeName: opts.cubeName,
          user: opts.user,
          since: epochToOData(anchorMs - windowMs),
          until: opts.until,
        });
      } catch (err) {
        // Permission/auth must surface; a window timeout just stops widening.
        if (
          err instanceof TM1Error &&
          (err.code === TM1ErrorCode.PERMISSION_DENIED || err.code === TM1ErrorCode.AUTH_FAILED)
        ) {
          throw err;
        }
        break;
      }
      if (entries.length >= top) return entries;
      collected = entries;
    }
    return collected;
  }

  /**
   * Single bounded TransactionLogEntries query. Runs once (retry disabled) under
   * a dedicated timeout: the endpoint is deterministically slow, so a timeout
   * means "range too large", not a transient blip. PERMISSION_DENIED/AUTH_FAILED
   * pass through; anything else becomes an actionable "narrow the range" error.
   */
  private async queryTransactionLog(q: {
    top: number;
    cubeName?: string | undefined;
    user?: string | undefined;
    since?: string | undefined;
    until?: string | undefined;
  }): Promise<TransactionLogEntry[]> {
    const filters: string[] = [];
    if (q.cubeName) filters.push(`Cube eq '${q.cubeName.replace(/'/g, "''")}'`);
    if (q.user) filters.push(`User eq '${q.user.replace(/'/g, "''")}'`);
    if (q.since) filters.push(`TimeStamp ge ${toOdataDateTime(q.since)}`);
    if (q.until) filters.push(`TimeStamp le ${toOdataDateTime(q.until)}`);
    const qs: string[] = [`$top=${q.top}`, `$orderby=TimeStamp desc`];
    if (filters.length > 0) qs.push(`$filter=${enc(filters.join(" and "))}`);
    const path = `/api/v1/TransactionLogEntries?${qs.join("&")}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TXLOG_QUERY_TIMEOUT_MS);
    try {
      const response = await this.http.request<{
        value: Array<{
          TimeStamp?: string;
          User?: string;
          Cube?: string;
          Tuple?: string[];
          OldValue?: CellValue;
          NewValue?: CellValue;
        }>;
      }>("GET", path, undefined, { signal: controller.signal, retry: false });
      return response.value.map((e) => ({
        timestamp: e.TimeStamp ?? "",
        user: e.User ?? "",
        cubeName: e.Cube ?? "",
        elements: e.Tuple ?? [],
        oldValue: e.OldValue ?? null,
        newValue: e.NewValue ?? null,
      }));
    } catch (err) {
      if (
        err instanceof TM1Error &&
        (err.code === TM1ErrorCode.PERMISSION_DENIED || err.code === TM1ErrorCode.AUTH_FAILED)
      ) {
        throw err;
      }
      throw new TM1Error({
        code: TM1ErrorCode.TM1_ERROR,
        message: `Transaction log query exceeded ${TXLOG_QUERY_TIMEOUT_MS / 1000}s — the time range is too large or dense.`,
        endpoint: path,
        details: err instanceof Error ? err.message : String(err),
        hint: "Bound the scan with a narrower since/until (from-to) range, or add cubeName/user.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cheap reachability/permission probe for the transaction log. A bare
   * `$top=1` (no $orderby/$filter) returns at most one row so TM1 can short-
   * circuit; a dedicated short-timeout AbortController caps the wait. Passes
   * through PERMISSION_DENIED/AUTH_FAILED as-is; anything else (timeout,
   * connection failure) becomes an actionable TM1_ERROR.
   */
  private async probeTransactionLog(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TXLOG_PROBE_TIMEOUT_MS);
    try {
      await this.http.request<{ value: unknown[] }>(
        "GET",
        "/api/v1/TransactionLogEntries?$top=1",
        undefined,
        { signal: controller.signal },
      );
    } catch (err) {
      if (
        err instanceof TM1Error &&
        (err.code === TM1ErrorCode.PERMISSION_DENIED || err.code === TM1ErrorCode.AUTH_FAILED)
      ) {
        throw err;
      }
      throw new TM1Error({
        code: TM1ErrorCode.TM1_ERROR,
        message: `Transaction log preflight failed (timeout ${TXLOG_PROBE_TIMEOUT_MS / 1000}s): the endpoint scans the whole log and may hang or be denied without log-read rights.`,
        endpoint: "/api/v1/TransactionLogEntries",
        details: err instanceof Error ? err.message : String(err),
        hint: "Narrow the query with `since`, `cubeName`, or `user`, or verify the account has transaction-log read rights.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List TI process error log files.
   *
   * TM1 v11 OData exposes only `Filename` on this entity set (no LastUpdated /
   * $select / $orderby support). Sorting is filename-descending — filenames
   * embed a yyyymmddhhmmss timestamp, so lexical desc sort matches
   * chronological newest-first. Filters (processName, since, top) are applied
   * client-side.
   */
  async listErrorLogFiles(opts: { processName?: string | undefined; since?: string | undefined; top?: number | undefined } = {}): Promise<ErrorLogFile[]> {
    const top = opts.top ?? 50;
    const response = await this.http.request<{ value: Array<{ Filename?: string }> }>(
      "GET",
      "/api/v1/ErrorLogFiles",
    );
    let entries = response.value
      .map((e): ErrorLogFile => ({ filename: e.Filename ?? "" }))
      .filter((e) => e.filename);

    if (opts.processName) {
      const proc = opts.processName.toLowerCase();
      // TM1 v11+ pattern with session hash: TM1ProcessError_<ts>_<id>_<proc>_<hash>.log
      // TM1 pattern without hash:           TM1ProcessError_<ts>_<id>_<proc>.log
      // Legacy/manual pattern:              <proc>_<ts>.log
      entries = entries.filter((e) => {
        const f = e.filename.toLowerCase();
        return (
          f === proc ||
          f.startsWith(`${proc}_`) ||
          f.endsWith(`_${proc}.log`) ||
          f.includes(`_${proc}_`)
        );
      });
    }
    if (opts.since) {
      const sinceCompact = opts.since.replace(/[^0-9]/g, "").slice(0, 14);
      if (sinceCompact.length >= 8) {
        entries = entries.filter((e) => {
          const m = e.filename.match(/(?:TM1ProcessError_|_)(\d{14})/) ?? e.filename.match(/_(\d{8,14})\.log$/i);
          return m ? m[1]! >= sinceCompact.slice(0, m[1]!.length) : true;
        });
      }
    }
    entries.sort((a, b) => (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0));
    return entries.slice(0, top);
  }

  /**
   * Fetch the raw text content of a single TI error log file.
   * GET /api/v1/ErrorLogFiles('<filename>')/Content
   */
  async getErrorLogContent(filename: string): Promise<string> {
    const path = `/api/v1/ErrorLogFiles('${enc(filename)}')/Content`;
    return await this.http.requestRaw("GET", path);
  }
}
