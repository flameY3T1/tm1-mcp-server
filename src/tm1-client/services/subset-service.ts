// Subset domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/{Subsets|PrivateSubsets} —
// list, get, create, update, delete. Subsets are either MDX-based
// (Expression) or static (Elements list); both shapes are handled here.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { Subset, SubsetCreate } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

const enc = encodeURIComponent;

export class SubsetService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List public + private subsets of a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets
   */
  async list(dimensionName: string, hierarchyName: string): Promise<Subset[]> {
    const result: Subset[] = [];
    const fetchScope = async (segment: "Subsets" | "PrivateSubsets", isPrivate: boolean) => {
      try {
        const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/${segment}?$select=Name,Expression,Alias`;
        const response = await this.http.request<{
          value: Array<{ Name: string; Expression?: string; Alias?: string }>;
        }>("GET", path);
        for (const s of response.value) {
          result.push({
            name: s.Name,
            dimensionName,
            hierarchyName,
            private: isPrivate,
            expression: s.Expression || undefined,
            elements: [],
            alias: s.Alias || undefined,
          });
        }
      } catch {
        // scope may not exist
      }
    };
    await fetchScope("Subsets", false);
    await fetchScope("PrivateSubsets", true);
    return result;
  }

  /**
   * Get a single subset incl. resolved Elements.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')?$expand=Elements($select=Name)
   */
  async get(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    isPrivate = false,
  ): Promise<Subset> {
    const segment = isPrivate ? "PrivateSubsets" : "Subsets";
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/${segment}('${enc(subsetName)}')?$expand=Elements($select=Name)&$select=Name,Expression,Alias`;
    const response = await this.http.request<{
      Name: string;
      Expression?: string;
      Alias?: string;
      Elements?: Array<{ Name: string }>;
    }>("GET", path);
    return {
      name: response.Name,
      dimensionName,
      hierarchyName,
      private: isPrivate,
      expression: response.Expression || undefined,
      elements: (response.Elements ?? []).map((e) => e.Name),
      alias: response.Alias || undefined,
    };
  }

  /**
   * Create a public subset. Either MDX-based (expression) or static
   * (elements). Mixed/empty inputs throw VALIDATION_ERROR.
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets
   */
  async create(
    dimensionName: string,
    hierarchyName: string,
    subset: SubsetCreate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Subsets`;

    if (subset.expression && subset.elements && subset.elements.length > 0) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Subset must be either MDX-based (expression) OR static (elements), not both.",
      });
    }
    if (!subset.expression && (!subset.elements || subset.elements.length === 0)) {
      throw new TM1Error({
        code: TM1ErrorCode.VALIDATION_ERROR,
        message: "Subset requires either expression (MDX) or non-empty elements list.",
      });
    }

    const body: Record<string, unknown> = { Name: subset.name };
    if (subset.alias) body.Alias = subset.alias;
    if (subset.expression) {
      body.Expression = subset.expression;
    } else {
      body["Elements@odata.bind"] = subset.elements!.map(
        (e) =>
          `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(e)}')`,
      );
    }
    await this.http.request<void>("POST", path, body);
  }

  /**
   * Update an existing public subset.
   * PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')
   */
  async update(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    update: { expression?: string | undefined; elements?: string[] | undefined; alias?: string | undefined },
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Subsets('${enc(subsetName)}')`;
    const body: Record<string, unknown> = {};
    if (update.alias !== undefined) body.Alias = update.alias;
    if (update.expression !== undefined) {
      body.Expression = update.expression;
    } else if (update.elements !== undefined) {
      body.Expression = "";
      body["Elements@odata.bind"] = update.elements.map(
        (e) =>
          `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(e)}')`,
      );
    }
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Delete a public subset.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')
   */
  async delete(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
  ): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Subsets('${enc(subsetName)}')`,
    );
  }
}
