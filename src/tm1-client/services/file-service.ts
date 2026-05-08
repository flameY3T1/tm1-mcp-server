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
}
