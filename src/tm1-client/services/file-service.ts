// File domain service. Owns the OData calls under /api/v1/Contents(...) — list
// files and read their raw content. Tries the v12 root `Files` first and falls
// back to the v11 root `Blobs`, since the same logical entity moved between
// product generations.
//
// A second container, `Applications`, holds the tree users see under
// "Applications" in Architect and PAW. It is addressed differently and the
// difference is measured, not assumed (11.8, 2026-09-21):
//   - entries are keyed by ID, not by Name; a document's ID is its name with
//     ".blob" appended, a folder's ID is its name. Names are resolved by
//     listing the parent rather than by deriving the ID, so one naming rule
//     changing on a future build cannot silently mis-address an entry.
//   - a document appears as a DocumentReference. Its bytes live one hop
//     further, behind a derived-type cast:
//     Contents('<id>')/ibm.tm1.api.v1.DocumentReference/Document/Content
//     `/Content` directly on the reference is a 404, and `$value` answers 501
//     on every resource in this tree.
//   - creating a document is a POST WITHOUT Content ("Document Content
//     property is of type stream." otherwise), then a PUT of the bytes.
//   - DELETE on a folder removes what it contains.
//
// See docs/ARCHITECTURE.md for the layering.
import { randomUUID } from "node:crypto";
import type { TM1HttpClient } from "../http.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { rethrowIfSystemic } from "./fallback.js";
import { odataKey } from "./odata-page.js";

// Split a user-supplied file path into segments, rejecting "." / ".." so a
// crafted name cannot traverse outside the Contents root.
function splitPath(raw: string): string[] {
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((p) => p === "." || p === "..")) {
    throw new TM1Error({
      code: TM1ErrorCode.VALIDATION_ERROR,
      message: `Invalid path "${raw}": "." and ".." segments are not allowed`,
      endpoint: raw,
    });
  }
  return parts;
}

/** Which storage tree a file operation addresses. */
export type FileContainer = "files" | "applications";

const APPS_ROOT = "/api/v1/Contents('Applications')";
const DOCUMENT_REFERENCE = "ibm.tm1.api.v1.DocumentReference";

interface AppsEntry {
  id: string;
  name: string;
  /** Trailing segment of @odata.type: Folder, DocumentReference, ViewReference. */
  kind: string;
}

export class FileService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Entries directly under a Contents URL, in either container.
   *
   * Follows `@odata.nextLink` if the server sends one. Whether these builds
   * page this endpoint at all was not observed; a missed page here would not
   * just shorten a listing, it would make name resolution answer NOT_FOUND for
   * an entry that exists, so the loop runs either way.
   */
  private async childrenOf(url: string): Promise<AppsEntry[]> {
    const entries: AppsEntry[] = [];
    // v12 leaves `ID` out of this listing unless it is selected (v11 always
    // sends it); without it every entry resolved to Contents('undefined').
    let next: string | undefined = `${url}/Contents?$select=ID,Name`;
    while (next) {
      const r: {
        value: Array<{ ID: string; Name: string; "@odata.type": string }>;
        "@odata.nextLink"?: string;
      } = await this.http.request("GET", next);
      for (const e of r.value) {
        entries.push({
          id: e.ID,
          name: e.Name,
          kind: e["@odata.type"].split(".").pop() ?? "",
        });
      }
      const link = r["@odata.nextLink"];
      // A nextLink may be absolute. Reduce it to a path: `request` prepends the
      // base URL. Its v12 rerooting only rewrites a leading `/api/v1`, which a
      // server-built link no longer carries, so it passes through untouched.
      next = link?.startsWith("http")
        ? new URL(link).pathname + new URL(link).search
        : link;
    }
    return entries;
  }

  /**
   * Walk name segments down the Applications tree, one listing per level.
   *
   * Costs a request per segment, which the depth of this tree makes cheap, and
   * buys two things a derived key cannot: the entry's real ID whatever the
   * server's naming rule is, and its type — so a caller asking for the bytes of
   * a ViewReference gets told what it actually hit.
   */
  private async appsResolve(
    segments: string[],
  ): Promise<{ url: string; entry: AppsEntry | undefined }> {
    let url = APPS_ROOT;
    let entry: AppsEntry | undefined;
    for (const seg of segments) {
      const children = await this.childrenOf(url);
      const lower = seg.toLowerCase();
      const hit =
        children.find((c) => c.name.toLowerCase() === lower) ??
        // A listing hands documents back under their name, but an ID pasted
        // straight from a previous response has to keep working too.
        children.find((c) => c.id.toLowerCase() === lower);
      if (!hit) {
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: `'${seg}' not found in the Applications tree`,
          endpoint: url,
        });
      }
      url += `/Contents('${odataKey(hit.id)}')`;
      entry = hit;
    }
    return { url, entry };
  }

  /** URL of the bytes behind a DocumentReference, or a typed refusal. */
  private appsContentUrl(url: string, entry: AppsEntry | undefined): string {
    if (entry === undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "The Applications root is not a file",
        endpoint: url,
      });
    }
    if (entry.kind !== "DocumentReference") {
      throw new TM1Error({
        code: TM1ErrorCode.UNSUPPORTED_OPERATION,
        message: `'${entry.name}' is a ${entry.kind}, which carries no file content`,
        hint:
          entry.kind === "Folder"
            ? "List it instead — tm1_list_files with container='applications' and this path."
            : "Only documents hold bytes. A ViewReference points at a cube view; read it with tm1_get_view.",
        endpoint: url,
      });
    }
    return `${url}/${DOCUMENT_REFERENCE}/Document/Content`;
  }

  /**
   * List files in TM1 server's blob/file storage.
   * v12: GET /api/v1/Contents('Files')[/Contents('subdir')...]/Contents?$select=Name
   * v11: same with 'Blobs' instead of 'Files'.
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async list(
    path?: string,
    container: FileContainer = "files",
  ): Promise<string[]> {
    const segments = path ? splitPath(path) : [];
    if (container === "applications") {
      const { url } = await this.appsResolve(segments);
      return (await this.childrenOf(url)).map((e) => e.name);
    }
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${odataKey(root)}')`;
      for (const seg of segments) {
        url += `/Contents('${odataKey(seg)}')`;
      }
      url += "/Contents?$select=Name";
      return url;
    };
    try {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        buildUrl("Files"),
      );
      return r.value.map((f) => f.Name);
    } catch (e) {
      rethrowIfSystemic(e);
      const r = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        buildUrl("Blobs"),
      );
      return r.value.map((f) => f.Name);
    }
  }

  /**
   * Get the content of a file from TM1 server's blob/file storage.
   * Returns raw text (CSV/TXT/etc).
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async getContent(
    fileName: string,
    container: FileContainer = "files",
  ): Promise<string> {
    return (await this.getContentBytes(fileName, container)).toString("utf8");
  }

  /**
   * The same read, byte-for-byte. The Applications tree holds spreadsheets and
   * other binaries, which a UTF-8 decode would quietly destroy.
   */
  async getContentBytes(
    fileName: string,
    container: FileContainer = "files",
  ): Promise<Buffer> {
    const parts = splitPath(fileName);
    if (container === "applications") {
      const { url, entry } = await this.appsResolve(parts);
      return this.http.requestRawBytes("GET", this.appsContentUrl(url, entry));
    }
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${odataKey(root)}')`;
      for (const p of parts) {
        url += `/Contents('${odataKey(p)}')`;
      }
      url += "/Content";
      return url;
    };
    try {
      return await this.http.requestRawBytes("GET", buildUrl("Files"));
    } catch (e) {
      rethrowIfSystemic(e);
      return await this.http.requestRawBytes("GET", buildUrl("Blobs"));
    }
  }

  /**
   * Check whether a file exists. Tries v12 'Files' first, falls back to 'Blobs'.
   * Implemented as a cheap GET on the entity ($select=Name) — TM1 REST does
   * not expose HEAD on these. 404 → false; other errors propagate.
   */
  async exists(
    fileName: string,
    container: FileContainer = "files",
  ): Promise<boolean> {
    const parts = splitPath(fileName);
    if (parts.length === 0) return false;
    if (container === "applications") {
      try {
        return (await this.appsResolve(parts)).entry !== undefined;
      } catch (e) {
        if ((e as { code?: string }).code === "NOT_FOUND") return false;
        throw e;
      }
    }
    const buildUrl = (root: string): string => {
      const segs = parts
        .slice(0, -1)
        .map((s) => `/Contents('${odataKey(s)}')`)
        .join("");
      // parts.length > 0 is guarded above
      const last = parts[parts.length - 1]!;
      return `/api/v1/Contents('${odataKey(root)}')${segs}/Contents('${odataKey(last)}')?$select=Name`;
    };
    const probe = async (url: string): Promise<boolean> => {
      try {
        await this.http.request("GET", url);
        return true;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "NOT_FOUND") return false;
        throw e;
      }
    };
    if (await probe(buildUrl("Files"))) return true;
    return probe(buildUrl("Blobs"));
  }

  /**
   * Upload (create-or-update) a file. Two-step v11 protocol:
   *   1. POST entity into the parent Contents collection (only if missing)
   *   2. PUT raw bytes to the entity's /Content
   * Tries 'Files' (v12) first, falls back to 'Blobs' (v11).
   *
   * Subfolders only supported on TM1 v12. Caller must ensure parent folders
   * exist (createFolder).
   */
  async upload(
    fileName: string,
    content: Uint8Array,
    container: FileContainer = "files",
    // Applications only: false refuses a document that is already there.
    overwrite = true,
  ): Promise<{ created: boolean; root: "Files" | "Blobs" | "Applications" }> {
    const parts = splitPath(fileName);
    if (parts.length === 0) {
      throw new Error("upload: empty file name");
    }
    if (container === "applications")
      return this.uploadToApplications(parts, content, overwrite);
    // parts.length > 0 is guarded above
    const leaf = parts[parts.length - 1]!;
    const parentSegs = parts
      .slice(0, -1)
      .map((s) => `/Contents('${odataKey(s)}')`)
      .join("");

    const tryRoot = async (
      root: "Files" | "Blobs",
    ): Promise<{ created: boolean; root: "Files" | "Blobs" }> => {
      const parentUrl = `/api/v1/Contents('${odataKey(root)}')${parentSegs}/Contents`;
      const contentUrl = `/api/v1/Contents('${odataKey(root)}')${parentSegs}/Contents('${odataKey(leaf)}')/Content`;

      const existed = await this.exists(fileName).catch(() => false);
      if (!existed) {
        await this.http.request("POST", parentUrl, {
          "@odata.type": "#ibm.tm1.api.v1.Document",
          ID: leaf,
          Name: leaf,
        });
      }
      try {
        await this.http.requestBinary("PUT", contentUrl, content);
      } catch (e) {
        // Same two-request split as the Applications path: an entry this call
        // created and could not fill is removed again, so a failed upload does
        // not leave an empty file under the name.
        if (!existed) {
          const url = `/api/v1/Contents('${odataKey(root)}')${parentSegs}/Contents('${odataKey(leaf)}')`;
          await this.http.request("DELETE", url).catch(() => undefined);
        }
        throw e;
      }
      return { created: !existed, root };
    };

    try {
      return await tryRoot("Files");
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "NOT_FOUND") throw e;
      return await tryRoot("Blobs");
    }
  }

  /**
   * Create a folder. The parent must exist.
   *
   * A folder that is already there answers created=false. That is decided by
   * listing the parent, not by the POST: in the Applications tree v11 reports
   * "already exists" as a plain 400, and v12 `Files` answers a second POST of
   * the same name with success (measured 2026-11-18).
   *
   * The 'files' container nests on v12 only. v11 `Blobs` is flat — the POST of
   * a Folder is refused there with an empty 400 — so that case is named here
   * instead of being sent.
   */
  async createFolder(
    path: string,
    container: FileContainer = "files",
  ): Promise<{ created: boolean }> {
    const parts = splitPath(path);
    const leaf = parts.pop();
    if (leaf === undefined) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Empty folder path",
        endpoint: path,
      });
    }
    let parentUrl: string;
    let siblings: AppsEntry[];
    if (container === "applications") {
      const { url, entry: parent } = await this.appsResolve(parts);
      if (parent !== undefined && parent.kind !== "Folder") {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `'${parent.name}' is a ${parent.kind}, not a folder`,
          endpoint: url,
        });
      }
      parentUrl = url;
      siblings = await this.childrenOf(url);
    } else {
      if (this.http.version === 11) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          // In the message, not the hint: the tool replaces the hint with its own.
          message:
            "TM1 v11 keeps the 'files' container flat: it has no folders. Use a flat file name there, or container='applications' for the tree users see in Architect and PAW.",
          endpoint: path,
        });
      }
      parentUrl =
        "/api/v1/Contents('Files')" +
        parts.map((p) => `/Contents('${odataKey(p)}')`).join("");
      siblings = await this.childrenOf(parentUrl);
    }
    const existing = siblings.find(
      (e) => e.name.toLowerCase() === leaf.toLowerCase(),
    );
    if (existing !== undefined) {
      if (existing.kind === "Folder") return { created: false };
      throw new TM1Error({
        code: TM1ErrorCode.CONFLICT,
        message: `'${leaf}' already exists as a ${existing.kind}`,
        endpoint: parentUrl,
      });
    }
    await this.http.request("POST", `${parentUrl}/Contents`, {
      "@odata.type": "#ibm.tm1.api.v1.Folder",
      Name: leaf,
    });
    return { created: true };
  }

  /** Refusal for a folder that still holds entries; DELETE would take them along. */
  private filledFolder(name: string, count: number, url: string): TM1Error {
    return new TM1Error({
      code: TM1ErrorCode.UNSUPPORTED_OPERATION,
      // The advice sits in the message: the tool replaces the hint with its own.
      message: `'${name}' is a folder holding ${count} ${count === 1 ? "entry" : "entries"} — refusing to delete it, because TM1 would delete them with it. Delete the entries first; an empty folder is deleted.`,
      endpoint: url,
    });
  }

  /**
   * Delete a file from blob/file storage. Tries 'Files' first, then 'Blobs'.
   */
  async delete(
    fileName: string,
    container: FileContainer = "files",
  ): Promise<void> {
    const parts = splitPath(fileName);
    if (parts.length === 0) {
      throw new Error("delete: empty file name");
    }
    if (container === "applications") {
      const { url, entry } = await this.appsResolve(parts);
      // DELETE on a folder takes everything under it with it (see the header
      // note), so a folder goes only when it is empty; decided here rather
      // than at the server, where the content would already be gone.
      if (entry?.kind === "Folder") {
        const count = (await this.childrenOf(url)).length;
        if (count > 0) throw this.filledFolder(entry.name, count, url);
      } else if (entry !== undefined && entry.kind !== "DocumentReference") {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `'${entry.name}' is a ${entry.kind}, not a file — refusing to delete it`,
          hint: "Only documents and empty folders can be deleted here. A ViewReference points at a cube view; remove it with tm1_delete_view.",
          endpoint: url,
        });
      }
      await this.http.request("DELETE", url);
      return;
    }
    const buildUrl = (root: string): string => {
      const segs = parts.map((s) => `/Contents('${odataKey(s)}')`).join("");
      return `/api/v1/Contents('${odataKey(root)}')${segs}`;
    };
    try {
      // v12 `Files` nests, and DELETE on a folder there removes its content
      // too (measured 2026-11-18). On v11 this read is the 404 that sends the
      // call on to `Blobs`, which has no folders.
      // shortcut: a folder is recognised by @odata.type in this answer (seen on 12.5.9); a build that leaves it out gets the plain DELETE again — then list the parent instead.
      const url = buildUrl("Files");
      const target = await this.http.request<{ "@odata.type"?: string }>(
        "GET",
        `${url}?$select=Name`,
      );
      if (target?.["@odata.type"]?.endsWith(".Folder")) {
        const count = (await this.childrenOf(url)).length;
        if (count > 0) {
          throw this.filledFolder(parts[parts.length - 1]!, count, url);
        }
      }
      await this.http.request("DELETE", url);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "NOT_FOUND") throw e;
      await this.http.request("DELETE", buildUrl("Blobs"));
    }
  }

  /**
   * Search file names in a folder using OData $filter.
   * - startswith: case-insensitive prefix match
   * - contains: list of case-insensitive substring matches, joined by `operator`
   */
  async search(opts: {
    startswith?: string | undefined;
    contains?: string[] | undefined;
    operator?: "and" | "or" | undefined;
    path?: string | undefined;
    container?: FileContainer | undefined;
  }): Promise<string[]> {
    const operator = opts.operator ?? "and";
    const segments = opts.path ? splitPath(opts.path) : [];
    if (opts.container === "applications") {
      // Filtered client-side: the $filter push-down is measured for Blobs, not
      // for this tree, and an Applications folder holds tens of entries, not
      // thousands. Same matching rules as the server-side clauses below.
      const names = await this.list(opts.path, "applications");
      const starts = opts.startswith?.toLowerCase();
      const subs = (opts.contains ?? []).map((c) => c.toLowerCase());
      return names.filter((n) => {
        const low = n.toLowerCase();
        if (starts !== undefined && !low.startsWith(starts)) return false;
        if (subs.length === 0) return true;
        return operator === "or"
          ? subs.some((c) => low.includes(c))
          : subs.every((c) => low.includes(c));
      });
    }
    const escape = (s: string): string => s.replace(/'/g, "''");
    const filters: string[] = [];
    if (opts.startswith) {
      filters.push(
        `startswith(tolower(Name),tolower('${escape(opts.startswith)}'))`,
      );
    }
    if (opts.contains && opts.contains.length > 0) {
      const subs = opts.contains.map(
        (s) => `contains(tolower(Name),tolower('${escape(s)}'))`,
      );
      filters.push(`(${subs.join(` ${operator} `)})`);
    }
    const filter =
      filters.length > 0
        ? `&$filter=${encodeURIComponent(filters.join(" and "))}`
        : "";
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${odataKey(root)}')`;
      for (const seg of segments) url += `/Contents('${odataKey(seg)}')`;
      url += `/Contents?$select=Name${filter}`;
      return url;
    };
    try {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        buildUrl("Files"),
      );
      return r.value.map((f) => f.Name);
    } catch (e) {
      rethrowIfSystemic(e);
      const r = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        buildUrl("Blobs"),
      );
      return r.value.map((f) => f.Name);
    }
  }

  /**
   * Read a text file from the server's file system through TI — v11 only.
   *
   * v11 `Contents('Blobs')` lists only files uploaded through REST (stored as
   * `<name>.blb` in the data directory); a file written by `ASCIIOutput`/
   * `TextOutput` or dropped into the data directory is a 404 there, root or
   * subfolder, even when it is named `<name>.blb` (measured 11.8, 2026-11-08
   * and 2026-11-14). `ErrorLogFiles`, however, serves every
   * `TM1ProcessError_*.log` in the logging directory byte for byte and deletes
   * it on DELETE. So an unbound process takes the file as its ASCII source and
   * copies each record into such a file, which is then fetched and removed.
   *
   * The source is set up so TI does not reinterpret the line: quote character
   * empty (quotes stay in the text) and DEL as delimiter (one variable = whole
   * line). Measured 11.8, 2026-11-14: the copy equals the source byte for byte
   * except that empty lines are not records and are dropped; 20000-character
   * lines survive; ANSI bytes pass through unchanged, hence the decode
   * fallback; an empty source creates no copy at all. A file with a UTF-8 BOM
   * is read as Unicode and copied as ANSI: right for cp1252 characters, lossy
   * beyond them.
   *
   * The path goes into the JSON data source, never into TI code, so it cannot
   * inject statements.
   */
  async readViaTi(
    path: string,
    maxLines: number,
  ): Promise<{
    lines: string[];
    truncated: boolean;
    encoding: "utf-8" | "windows-1252";
  }> {
    const copy = `TM1ProcessError_mcpread_${randomUUID()}.log`;
    const copyUrl = `/api/v1/ErrorLogFiles('${copy}')`;
    const body = {
      Process: {
        Name: "}tm1-mcp-read-file",
        HasSecurityAccess: false,
        PrologProcedure: `n = 0;\nDatasourceASCIIQuoteCharacter = '';\nvOut = GetProcessErrorFileDirectory | '${copy}';`,
        MetadataProcedure: "",
        // One record more than asked for tells a cut file from a complete one.
        DataProcedure: `n = n + 1;\nIF(n > ${maxLines + 1});\nProcessBreak;\nENDIF;\nASCIIOutput(vOut, vLine);`,
        EpilogProcedure: "",
        DataSource: {
          Type: "ASCII",
          dataSourceNameForServer: path,
          dataSourceNameForClient: path,
          asciiDelimiterType: "Character",
          asciiDelimiterChar: "\u007f",
          asciiQuoteCharacter: "",
          asciiHeaderRecords: 0,
          asciiDecimalSeparator: ".",
          asciiThousandSeparator: ",",
        },
        Variables: [
          {
            Name: "vLine",
            Type: "String",
            Position: 1,
            StartByte: 0,
            EndByte: 0,
          },
        ],
      },
    };
    let copyExists = true;
    try {
      const r = await this.http.request<{
        ProcessExecuteStatusCode?: string;
        ErrorLogFile?: { Filename?: string } | null;
      }>("POST", "/api/v1/ExecuteProcessWithReturn?$expand=ErrorLogFile", body);
      const status = r?.ProcessExecuteStatusCode;
      if (status !== "CompletedSuccessfully") {
        const logName = r?.ErrorLogFile?.Filename;
        const logUrl = `/api/v1/ErrorLogFiles('${odataKey(logName ?? "")}')`;
        const log = logName
          ? await this.http.requestRaw("GET", `${logUrl}/Content`)
          : "";
        // The log of this throwaway process is in `details`; do not keep it.
        if (logName)
          await this.http
            .request<void>("DELETE", logUrl)
            .catch(() => undefined);
        throw new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: `TI could not read "${path}" (status ${status ?? "missing"})`,
          details: log.slice(0, 1000),
          hint: "Use the path as TI sees it: absolute on the server (e.g. C:\\TM1\\data\\export.csv) or relative to the data directory.",
          endpoint: path,
        });
      }
      let bytes: Buffer;
      try {
        bytes = await this.http.requestRawBytes("GET", `${copyUrl}/Content`);
      } catch (err) {
        // No record, no copy: the source is empty.
        if (err instanceof TM1Error && err.code === TM1ErrorCode.NOT_FOUND) {
          copyExists = false;
          return { lines: [], truncated: false, encoding: "utf-8" };
        }
        throw err;
      }
      let text: string;
      let encoding: "utf-8" | "windows-1252" = "utf-8";
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
        encoding = "windows-1252";
      }
      const lines = text.split("\r\n");
      lines.pop(); // ASCIIOutput ends every record with CRLF
      return {
        lines: lines.slice(0, maxLines),
        truncated: lines.length > maxLines,
        encoding,
      };
    } finally {
      // Never leave the copy in the logging directory.
      if (copyExists)
        await this.http.request<void>("DELETE", copyUrl).catch(() => undefined);
    }
  }

  /**
   * Create-or-update a document in the Applications tree.
   *
   * Three steps, each one measured: POST the entity WITHOUT Content (inlining
   * it is refused — the property is a stream), re-resolve to learn the ID the
   * server assigned, then PUT the bytes behind the cast.
   */
  private async uploadToApplications(
    parts: string[],
    content: Uint8Array,
    overwrite: boolean,
  ): Promise<{ created: boolean; root: "Applications" }> {
    const leaf = parts[parts.length - 1]!;
    const parentParts = parts.slice(0, -1);
    const { url: parentUrl } = await this.appsResolve(parentParts);

    const existing = (await this.childrenOf(parentUrl)).find(
      (e) => e.name.toLowerCase() === leaf.toLowerCase(),
    );
    if (existing !== undefined && existing.kind !== "DocumentReference") {
      throw new TM1Error({
        code: TM1ErrorCode.UNSUPPORTED_OPERATION,
        message: `'${leaf}' already exists as a ${existing.kind} and is not a document`,
        endpoint: parentUrl,
      });
    }
    if (existing !== undefined && !overwrite) {
      throw new TM1Error({
        code: TM1ErrorCode.CONFLICT,
        message: `Document '${leaf}' already exists in the Applications tree`,
        hint: "Pass overwrite=true to replace its content.",
        endpoint: parentUrl,
      });
    }
    if (existing === undefined) {
      await this.http.request("POST", `${parentUrl}/Contents`, {
        "@odata.type": "#ibm.tm1.api.v1.Document",
        Name: leaf,
      });
    }

    const { url, entry } = await this.appsResolve([...parentParts, leaf]);
    try {
      await this.http.requestBinary(
        "PUT",
        this.appsContentUrl(url, entry),
        content,
      );
    } catch (e) {
      // Create and write are two requests. If the write fails on an entry this
      // call created, take it back out — leaving an empty document behind would
      // report a failed upload while the name now exists.
      if (existing === undefined) {
        await this.http.request("DELETE", url).catch(() => undefined);
      }
      throw e;
    }
    return { created: existing === undefined, root: "Applications" };
  }
}
