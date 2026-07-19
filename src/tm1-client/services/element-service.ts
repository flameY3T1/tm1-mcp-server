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
import { rethrowIfSystemic } from "./fallback.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

// TM1 signals "element already exists" with different HTTP statuses across
// versions: some return 409 Conflict, but v11.x (REST 11.8) returns 400 with
// the message "An element with name ... already exists". Detect both so bulk
// upsert stays idempotent (update existing) rather than throwing on re-upsert.
export function isAlreadyExists(err: TM1Error): boolean {
  if (err.httpStatus === 409) return true;
  if (err.httpStatus === 400) {
    const text = `${err.message} ${err.details ?? ""}`.toLowerCase();
    return text.includes("already exists");
  }
  return false;
}

// TM1 may report an element's Type as the enum name ("Numeric"|"String"|
// "Consolidated") or its ordinal (1|2|3). Normalize to the name so callers can
// compare against ElementCreate.type regardless of representation.
function normalizeElementType(t: number | string): string {
  switch (t) {
    case 1:
    case "1":
      return "Numeric";
    case 2:
    case "2":
      return "String";
    case 3:
    case "3":
      return "Consolidated";
    default:
      return String(t);
  }
}

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
   * Scan element names in a hierarchy with a hard cap, paginating server-side.
   *
   * A single bulk Elements fetch can exceed V8's max string length on large
   * dimensions (response.text() buffers the whole body into one string), so
   * this probes the total via $count on the first page, then pages by
   * `pageSize` until either `maxScan` names are collected or the hierarchy is
   * exhausted. Callers learn the true `total` and whether the scan was
   * `truncated` — never a silent skip. Owns the V8-string-limit workaround so
   * tools don't reimplement raw OData paging.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name
   */
  async scanElementNames(
    dimensionName: string,
    hierarchyName: string,
    opts: { pageSize: number; maxScan: number },
  ): Promise<{ names: string[]; total: number; scanned: number; truncated: boolean }> {
    const { pageSize, maxScan } = opts;
    const basePath =
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')` +
      `/Elements?$select=Name&$top=${pageSize}`;

    // First page carries $count=true so we learn the total in one round-trip
    // without the /$count endpoint (TM1 v11 returns text/plain there and
    // rejects the Accept: application/json the shared HTTP client sends).
    const firstPage = await this.http.request<{
      "@odata.count"?: number;
      value: Array<{ Name: string }>;
    }>("GET", `${basePath}&$skip=0&$count=true`);

    const total = firstPage["@odata.count"] ?? firstPage.value.length;
    const scanLimit = Math.min(total, maxScan);
    const names: string[] = [];

    const firstSliceEnd = Math.min(firstPage.value.length, scanLimit);
    for (let i = 0; i < firstSliceEnd; i++) {
      names.push(firstPage.value[i]!.Name);
    }
    let skip = firstPage.value.length;
    let lastPageSize = firstPage.value.length;
    while (lastPageSize === pageSize && names.length < scanLimit) {
      const page = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        `${basePath}&$skip=${skip}`,
      );
      const remaining = scanLimit - names.length;
      const sliceEnd = Math.min(page.value.length, remaining);
      for (let i = 0; i < sliceEnd; i++) {
        names.push(page.value[i]!.Name);
      }
      lastPageSize = page.value.length;
      skip += page.value.length;
    }

    return { names, total, scanned: names.length, truncated: total > maxScan };
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
  ): Promise<{ typeChanges: Array<{ name: string; from: string; to: string }> }> {
    const baseUrl = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;
    const typeChanges: Array<{ name: string; from: string; to: string }> = [];

    // Pass 1: Create/upsert all elements without components.
    for (const el of elements) {
      const body: Record<string, unknown> = { Name: el.name, Type: el.type };
      try {
        await this.http.request<void>("POST", baseUrl, body);
      } catch (err) {
        if (err instanceof TM1Error && isAlreadyExists(err)) {
          // Element already exists. Patch the type only when it actually
          // differs (avoids a pointless write), and surface the change: a
          // Numeric->Consolidated / Numeric->String conversion discards the
          // element's leaf cell values, so the caller must be told it happened
          // rather than have it occur silently.
          const existing = await this.http
            .request<{ Type: number | string }>("GET", `${baseUrl}('${enc(el.name)}')?$select=Type`)
            .catch((e: unknown): null => {
              // A transport/auth outage here must NOT collapse into the
              // unconditional-PATCH branch below: that would silently change the
              // element type (discarding leaf values) on a network blip. Only a
              // genuine "type unreadable" (e.g. NOT_FOUND) may fall through to null.
              rethrowIfSystemic(e);
              return null;
            });
          const from = existing ? normalizeElementType(existing.Type) : null;
          if (from && from !== el.type) {
            await this.http.request<void>("PATCH", `${baseUrl}('${enc(el.name)}')`, { Type: el.type });
            typeChanges.push({ name: el.name, from, to: el.type });
          } else if (!from) {
            // Type unreadable — preserve prior behaviour and patch unconditionally.
            await this.http.request<void>("PATCH", `${baseUrl}('${enc(el.name)}')`, { Type: el.type });
          }
        } else {
          throw err;
        }
      }
    }

    // Pass 2: Set components for consolidated elements.
    // PATCH {Components:[...]} is FULL-REPLACE, not append (verified live vs
    // TM1 v11: upserting [L3,L4] over existing [L1,L2] leaves the element with
    // exactly {L3,L4}). Consolidations with no/empty components are skipped
    // here, so an upsert that omits components leaves existing children intact
    // — only a non-empty list rewrites the child set. Documented on the tool's
    // `components` input so callers don't silently drop children.
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

    return { typeChanges };
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
    // Escape `]` → `]]` in every bracketed identifier: an element or dimension
    // named e.g. `Foo]` would otherwise break out of its MDX identifier and
    // shift the read onto arbitrary members (MDX injection).
    const esc = (s: string): string => s.replace(/]/g, "]]");
    const dim = esc(dimensionName);
    const elem = esc(elementName);
    const ctrlCube = `}ElementAttributes_${dim}`;
    const mdx =
      `SELECT {[}ElementAttributes_${dim}].MEMBERS} ON COLUMNS ` +
      `FROM [${ctrlCube}] ` +
      `WHERE ([${dim}].[${elem}])`;
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
