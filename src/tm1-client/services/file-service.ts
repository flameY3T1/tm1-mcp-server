// File domain service. Owns the OData calls under /api/v1/Contents(...) — list
// files and read their raw content. Tries the v12 root `Files` first and falls
// back to the v11 root `Blobs`, since the same logical entity moved between
// product generations.
//
// See docs/ARCHITECTURE.md for the layering.
import type { TM1HttpClient } from "../http.js";

const enc = encodeURIComponent;

export class FileService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List files in TM1 server's blob/file storage.
   * v12: GET /api/v1/Contents('Files')[/Contents('subdir')...]/Contents?$select=Name
   * v11: same with 'Blobs' instead of 'Files'.
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async list(path?: string): Promise<string[]> {
    const segments = path ? path.split("/").filter(Boolean) : [];
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${enc(root)}')`;
      for (const seg of segments) {
        url += `/Contents('${enc(seg)}')`;
      }
      url += "/Contents?$select=Name";
      return url;
    };
    try {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Files"));
      return r.value.map((f) => f.Name);
    } catch {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Blobs"));
      return r.value.map((f) => f.Name);
    }
  }

  /**
   * Get the content of a file from TM1 server's blob/file storage.
   * Returns raw text (CSV/TXT/etc).
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async getContent(fileName: string): Promise<string> {
    const parts = fileName.split("/").filter(Boolean);
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${enc(root)}')`;
      for (const p of parts) {
        url += `/Contents('${enc(p)}')`;
      }
      url += "/Content";
      return url;
    };
    try {
      return await this.http.requestRaw("GET", buildUrl("Files"));
    } catch {
      return await this.http.requestRaw("GET", buildUrl("Blobs"));
    }
  }

  /**
   * Check whether a file exists. Tries v12 'Files' first, falls back to 'Blobs'.
   * Implemented as a cheap GET on the entity ($select=Name) — TM1 REST does
   * not expose HEAD on these. 404 → false; other errors propagate.
   */
  async exists(fileName: string): Promise<boolean> {
    const parts = fileName.split("/").filter(Boolean);
    if (parts.length === 0) return false;
    const buildUrl = (root: string): string => {
      const segs = parts.slice(0, -1).map((s) => `/Contents('${enc(s)}')`).join("");
      // parts.length > 0 is guarded above
      const last = parts[parts.length - 1]!;
      return `/api/v1/Contents('${enc(root)}')${segs}/Contents('${enc(last)}')?$select=Name`;
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
   * exist (folder-create not yet exposed).
   */
  async upload(fileName: string, content: Uint8Array): Promise<{ created: boolean; root: "Files" | "Blobs" }> {
    const parts = fileName.split("/").filter(Boolean);
    if (parts.length === 0) {
      throw new Error("upload: empty file name");
    }
    // parts.length > 0 is guarded above
    const leaf = parts[parts.length - 1]!;
    const parentSegs = parts.slice(0, -1).map((s) => `/Contents('${enc(s)}')`).join("");

    const tryRoot = async (root: "Files" | "Blobs"): Promise<{ created: boolean; root: "Files" | "Blobs" }> => {
      const parentUrl = `/api/v1/Contents('${enc(root)}')${parentSegs}/Contents`;
      const contentUrl = `/api/v1/Contents('${enc(root)}')${parentSegs}/Contents('${enc(leaf)}')/Content`;

      const existed = await this.exists(fileName).catch(() => false);
      if (!existed) {
        await this.http.request("POST", parentUrl, {
          "@odata.type": "#ibm.tm1.api.v1.Document",
          ID: leaf,
          Name: leaf,
        });
      }
      await this.http.requestBinary("PUT", contentUrl, content);
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
   * Delete a file from blob/file storage. Tries 'Files' first, then 'Blobs'.
   */
  async delete(fileName: string): Promise<void> {
    const parts = fileName.split("/").filter(Boolean);
    if (parts.length === 0) {
      throw new Error("delete: empty file name");
    }
    const buildUrl = (root: string): string => {
      const segs = parts.map((s) => `/Contents('${enc(s)}')`).join("");
      return `/api/v1/Contents('${enc(root)}')${segs}`;
    };
    try {
      await this.http.request("DELETE", buildUrl("Files"));
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
    startswith?: string;
    contains?: string[];
    operator?: "and" | "or";
    path?: string;
  }): Promise<string[]> {
    const operator = opts.operator ?? "and";
    const segments = opts.path ? opts.path.split("/").filter(Boolean) : [];
    const escape = (s: string): string => s.replace(/'/g, "''");
    const filters: string[] = [];
    if (opts.startswith) {
      filters.push(`startswith(tolower(Name),tolower('${escape(opts.startswith)}'))`);
    }
    if (opts.contains && opts.contains.length > 0) {
      const subs = opts.contains.map((s) => `contains(tolower(Name),tolower('${escape(s)}'))`);
      filters.push(`(${subs.join(` ${operator} `)})`);
    }
    const filter = filters.length > 0 ? `&$filter=${encodeURIComponent(filters.join(" and "))}` : "";
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${enc(root)}')`;
      for (const seg of segments) url += `/Contents('${enc(seg)}')`;
      url += `/Contents?$select=Name${filter}`;
      return url;
    };
    try {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Files"));
      return r.value.map((f) => f.Name);
    } catch {
      const r = await this.http.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Blobs"));
      return r.value.map((f) => f.Name);
    }
  }
}
