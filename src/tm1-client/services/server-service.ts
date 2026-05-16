// Server domain service. Owns server-level read endpoints — configuration,
// message log, transaction log, error-log files. Stateless wrappers; nothing
// here mutates server state.
//
// See docs/ARCHITECTURE.md for the layering.
import type {
  CellValue,
  ErrorLogFile,
  MessageLogEntry,
  ServerInfo,
  TransactionLogEntry,
} from "../../types.js";
import type { TM1HttpClient } from "../http.js";

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
   * Fetch recent TM1 transaction log entries (cell writes).
   * GET /api/v1/TransactionLogEntries
   */
  async getTransactionLog(opts: {
    top?: number;
    cubeName?: string;
    user?: string;
    since?: string; // ISO timestamp
  }): Promise<TransactionLogEntry[]> {
    const filters: string[] = [];
    if (opts.cubeName) filters.push(`Cube eq '${opts.cubeName.replace(/'/g, "''")}'`);
    if (opts.user) filters.push(`User eq '${opts.user.replace(/'/g, "''")}'`);
    if (opts.since) filters.push(`TimeStamp ge ${opts.since}`);
    const top = opts.top ?? 100;
    const qs: string[] = [`$top=${top}`, `$orderby=TimeStamp desc`];
    if (filters.length > 0) qs.push(`$filter=${enc(filters.join(" and "))}`);
    const path = `/api/v1/TransactionLogEntries?${qs.join("&")}`;
    const response = await this.http.request<{
      value: Array<{
        TimeStamp?: string;
        User?: string;
        Cube?: string;
        Tuple?: string[];
        OldValue?: CellValue;
        NewValue?: CellValue;
      }>;
    }>("GET", path);
    return response.value.map((e) => ({
      timestamp: e.TimeStamp ?? "",
      user: e.User ?? "",
      cubeName: e.Cube ?? "",
      elements: e.Tuple ?? [],
      oldValue: e.OldValue ?? null,
      newValue: e.NewValue ?? null,
    }));
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
  async listErrorLogFiles(opts: { processName?: string; since?: string; top?: number } = {}): Promise<ErrorLogFile[]> {
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
