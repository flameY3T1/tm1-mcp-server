// Dimension domain service. Owns the OData calls under /api/v1/Dimensions(...) —
// list, create, delete. Hierarchy and element operations live in their own
// sibling services. See docs/ARCHITECTURE.md for the layering.
import { TM1Error } from "../../types.js";
import type { Dimension } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

const enc = encodeURIComponent;

export class DimensionService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all dimensions with their hierarchy names.
   * GET /api/v1/Dimensions?$expand=Hierarchies($select=Name)
   *
   * When opts.includeElementCount is true, the expand also requests
   * `Elements($count=true;$top=0)` so each Hierarchy returns
   * `Elements@odata.count` without paying for the full element list.
   * Single round-trip — drop-in for audit workflows that previously
   * called getHierarchy() N times just to size dimensions.
   */
  async list(opts?: { includeElementCount?: boolean }): Promise<Dimension[]> {
    const expand = opts?.includeElementCount
      ? "Hierarchies($select=Name;$expand=Elements($count=true;$top=0))"
      : "Hierarchies($select=Name)";
    const response = await this.http.request<{
      value: Array<{
        Name: string;
        Hierarchies: Array<{ Name: string; "Elements@odata.count"?: number }>;
      }>;
    }>("GET", `/api/v1/Dimensions?$expand=${expand}`);
    return response.value.map((d) => {
      const dim: Dimension = {
        name: d.Name,
        hierarchies: d.Hierarchies.map((h) => h.Name),
      };
      if (opts?.includeElementCount) {
        dim.elementCounts = Object.fromEntries(
          d.Hierarchies.map((h) => [h.Name, h["Elements@odata.count"] ?? 0]),
        );
      }
      return dim;
    });
  }

  /**
   * Create a new dimension. TM1 11.8 does not auto-create the default
   * hierarchy from the POST body — we issue an explicit follow-up POST
   * and tolerate 409 (some versions create it automatically).
   * POST /api/v1/Dimensions
   */
  async create(name: string): Promise<void> {
    await this.http.request<void>("POST", "/api/v1/Dimensions", { Name: name });
    try {
      await this.http.request<void>(
        "POST",
        `/api/v1/Dimensions('${enc(name)}')/Hierarchies`,
        { Name: name },
      );
    } catch (err) {
      if (err instanceof TM1Error && err.httpStatus === 409) {
        return;
      }
      throw err;
    }
  }

  /**
   * Delete a dimension and all its hierarchies.
   * DELETE /api/v1/Dimensions('{name}')
   */
  async delete(name: string): Promise<void> {
    await this.http.request<void>("DELETE", `/api/v1/Dimensions('${enc(name)}')`);
  }
}
