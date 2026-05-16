// Element domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...) — create, update,
// delete, move, bulk upsert, ElementAttribute definition CRUD, plus the
// element-attribute VALUE read/write that goes through the
// `}ElementAttributes_{Dim}` control cube. Those last two methods route
// through CellService for the underlying MDX read and cellset PATCH.
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error } from "../../types.js";
import type { ElementAttributeValue, ElementCreate, ElementUpdate } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import type { CellService } from "./cell-service.js";

const enc = encodeURIComponent;

export class ElementService {
  constructor(
    private readonly http: TM1HttpClient,
    private readonly cells: CellService,
  ) {}

  /**
   * Create an element in a hierarchy. Consolidated elements may include
   * Components inline; their target elements must already exist.
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements
   */
  async create(
    dimensionName: string,
    hierarchyName: string,
    element: ElementCreate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;
    const body: Record<string, unknown> = {
      Name: element.name,
      Type: element.type,
    };
    if (element.type === "Consolidated" && element.components && element.components.length > 0) {
      body.Components = element.components.map((c) => ({
        "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
        Weight: c.weight,
      }));
    }
    await this.http.request<void>("POST", path, body);
  }

  /**
   * Update an existing element (rename, type change, replace components).
   * PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{name}')
   */
  async update(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    update: ElementUpdate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(elementName)}')`;
    const body: Record<string, unknown> = {};
    if (update.newName !== undefined) {
      body.Name = update.newName;
    }
    if (update.type !== undefined) {
      body.Type = update.type;
    }
    if (update.components !== undefined) {
      body.Components = update.components.map((c) => ({
        "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
        Weight: c.weight,
      }));
    }
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Delete an element. May fail if the element is referenced in rules.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{name}')
   */
  async delete(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(elementName)}')`;
    await this.http.request<void>("DELETE", path);
  }

  /**
   * Add an element as a component of a new parent.
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{newParent}')/Components
   */
  async move(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    newParent: string,
    weight?: number,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(newParent)}')/Components`;
    const body = {
      "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(elementName)}')`,
      Weight: weight ?? 1,
    };
    await this.http.request<void>("POST", path, body);
  }

  /**
   * Bulk upsert elements into a hierarchy. Two-pass to ensure leaves exist
   * before consolidations reference them: pass 1 creates/upserts every element
   * (PATCH on 409), pass 2 sets Components for Consolidated elements.
   * POST/PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...)
   */
  async bulkUpsert(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<void> {
    const baseUrl = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;

    // Pass 1: Create/upsert all elements without components.
    for (const el of elements) {
      const body: Record<string, unknown> = { Name: el.name, Type: el.type };
      try {
        await this.http.request<void>("POST", baseUrl, body);
      } catch (err) {
        if (err instanceof TM1Error && err.httpStatus === 409) {
          // Already exists – patch type if needed.
          await this.http.request<void>("PATCH", `${baseUrl}('${enc(el.name)}')`, { Type: el.type });
        } else {
          throw err;
        }
      }
    }

    // Pass 2: Set components for consolidated elements.
    const consolidated = elements.filter(
      (el) => el.type === "Consolidated" && el.components && el.components.length > 0,
    );
    for (const el of consolidated) {
      const path = `${baseUrl}('${enc(el.name)}')`;
      const body = {
        Components: el.components!.map((c) => ({
          "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
          Weight: c.weight,
        })),
      };
      await this.http.request<void>("PATCH", path, body);
    }
  }

  /**
   * List element-attribute definitions for a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/ElementAttributes
   */
  async listAttributes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: "Numeric" | "String" | "Alias" }>> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/ElementAttributes`;
    const response = await this.http.request<{
      value: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return response.value.map((a) => ({
      name: a.Name,
      type: a.Type as "Numeric" | "String" | "Alias",
    }));
  }

  /**
   * Define a new element attribute on a hierarchy. Prefer TI prolog
   * (DimensionElementInsert on `}ElementAttributes_{dim}`) for reproducible
   * deployments — this REST path is for ad-hoc / debugging use.
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/ElementAttributes
   */
  async createAttribute(
    dimensionName: string,
    hierarchyName: string,
    attributeName: string,
    attributeType: "Numeric" | "String" | "Alias",
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/ElementAttributes`;
    await this.http.request<void>("POST", path, {
      Name: attributeName,
      Type: attributeType,
    });
  }

  /**
   * Read all attribute values for one element via MDX on
   * `}ElementAttributes_{Dim}`. Routes through CellService.executeMdx for the
   * cellset round-trip.
   */
  async getAttributeValues(
    dimensionName: string,
    elementName: string,
  ): Promise<ElementAttributeValue[]> {
    const ctrlCube = `}ElementAttributes_${dimensionName}`;
    const mdx =
      `SELECT {[}ElementAttributes_${dimensionName}].MEMBERS} ON COLUMNS ` +
      `FROM [${ctrlCube}] ` +
      `WHERE ([${dimensionName}].[${elementName}])`;
    const result = await this.cells.executeMdx(mdx);
    const out: ElementAttributeValue[] = [];
    const tuples = result.axes[0]?.tuples ?? [];
    for (let i = 0; i < tuples.length; i++) {
      const attrName = tuples[i]!.members[0]?.name ?? "";
      const cell = result.cells[i];
      out.push({
        elementName,
        attributeName: attrName,
        value: cell?.value ?? null,
      });
    }
    return out;
  }

  /**
   * Set a single attribute value on an element by writing to the
   * `}ElementAttributes_{Dim}` control cube via CellService.writeCells.
   *
   * Prefer TI processes (CellPutS / AttrPutS) for reproducible deployments;
   * this REST-direct path is for ad-hoc / debugging use.
   */
  async updateAttributeValue(
    dimensionName: string,
    elementName: string,
    attributeName: string,
    value: number | string,
  ): Promise<void> {
    const ctrlCube = `}ElementAttributes_${dimensionName}`;
    await this.cells.writeCells(
      ctrlCube,
      [dimensionName, `}ElementAttributes_${dimensionName}`],
      [{ elements: [elementName, attributeName], value }],
    );
  }
}
