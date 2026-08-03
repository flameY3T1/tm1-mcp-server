// Element domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...) — create, update,
// delete, move, bulk upsert, ElementAttribute definition CRUD, plus the
// element-attribute VALUE read/write that goes through the
// `}ElementAttributes_{Dim}` control cube. Those last two methods route
// through CellService for the underlying MDX read and cellset PATCH.
//
// See docs/ARCHITECTURE.md for the layering.
import { mapSettledWithConcurrency } from "../../lib/concurrency.js";
import { TM1Error } from "../../types.js";
import type {
  ElementAttributeValue,
  ElementCreate,
  ElementUpdate,
} from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { BatchUnsupportedError } from "./batch-service.js";
import type {
  BatchRequest,
  BatchService,
  BatchSubResult,
} from "./batch-service.js";
import type { CellService } from "./cell-service.js";
import { rethrowIfSystemic } from "./fallback.js";

// Max in-flight per-element REST calls within a single bulkUpsert pass. Bounds
// pressure on TM1's worker pool (mirrors the cap the feeder-audit fan-out uses)
// while removing the serialized 2-3N round-trips on an explicitly-bulk op.
const BULK_UPSERT_CONCURRENCY = 8;

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string =>
  encodeURIComponent(String(s).replace(/'/g, "''"));

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

/**
 * Reject with the first failure in ELEMENT order (not response order), so the
 * error a caller sees is the same one the per-request path would surface.
 * Successful sub-requests in the same batch stay committed — TM1's $batch is
 * non-atomic — exactly as the concurrent per-request path already leaves
 * earlier writes committed when a later one fails.
 */
function throwFirstFailure(
  results: BatchSubResult[],
  indexOf: (id: string) => number,
): void {
  let firstIndex = Number.POSITIVE_INFINITY;
  let firstError: TM1Error | undefined;
  for (const r of results) {
    if (r.ok) continue;
    const i = indexOf(r.id);
    if (i < firstIndex) {
      firstIndex = i;
      firstError = r.error;
    }
  }
  if (firstError) throw firstError;
}

export class ElementService {
  constructor(
    private readonly http: TM1HttpClient,
    private readonly cells: CellService,
    // Optional so a caller (and the existing unit tests) can build an
    // ElementService that only ever uses the per-request path. Production wires
    // it, which turns bulkUpsert's N round-trips into a handful of $batch calls.
    private readonly batch?: BatchService,
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
    if (
      element.type === "Consolidated" &&
      element.components &&
      element.components.length > 0
    ) {
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
  ): Promise<{
    names: string[];
    total: number;
    scanned: number;
    truncated: boolean;
  }> {
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
   *
   * Prefers OData `$batch` (a handful of round-trips) and falls back to the
   * per-request fan-out when the server has no `$batch` endpoint. Both paths
   * produce the identical result and the identical throw-on-any-failure
   * contract; only the number of HTTP calls differs.
   */
  async bulkUpsert(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<{
    typeChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    if (this.batch && !this.batch.isKnownUnsupported) {
      try {
        return await this.bulkUpsertViaBatch(
          dimensionName,
          hierarchyName,
          elements,
        );
      } catch (err) {
        // ONLY "this server has no $batch" falls through. A sub-request failure
        // is not an exception here (it is reported per item and rethrown as the
        // element error), and a systemic transport/auth error propagates from
        // BatchService — neither may silently re-drive the writes.
        //
        // Restarting on the per-request path cannot duplicate or lose work —
        // but NOT because nothing was committed. TM1's $batch is non-atomic
        // (verified live), so an envelope that fails mid-way leaves the
        // sub-requests it already processed in place. What makes the restart
        // safe is WHICH sub-requests those can be: BatchService raises
        // BatchUnsupportedError only before the first successful batch on the
        // connection, and the only pass that can run before that is pass 1a —
        // create-only. Re-creating an element the failed batch already created
        // just takes the "already exists" upsert branch, sees the type it was
        // created with, and patches nothing.
        //
        // The destructive passes are unreachable here by construction: pass 1c
        // (Type PATCH) and pass 2 (Components) only run after pass 1a returned
        // a valid envelope, which sets supported=true and disables this
        // fallback. A batch that fails AFTER one has succeeded (flaky gateway
        // mid-chunk) propagates as a real error instead — which matters,
        // because replaying an already-applied Type PATCH would re-probe, see
        // the new type, and report no typeChange for a conversion that did
        // discard leaf values.
        //
        // tests/unit/batch-fallback-safety.test.ts pins both halves of this.
        if (!(err instanceof BatchUnsupportedError)) throw err;
      }
    }
    return this.bulkUpsertPerRequest(dimensionName, hierarchyName, elements);
  }

  /**
   * `$batch` implementation of bulkUpsert: four PASSES regardless of element
   * count — create-all, read-type-of-the-ones-that-existed,
   * patch-the-types-that-differ, then the consolidation Components patches.
   * Each pass is one round-trip per BATCH_MAX_REQUESTS sub-requests (they are
   * chunked inside BatchService), so N elements cost roughly 4 * ceil(N/200)
   * calls instead of N.
   */
  private async bulkUpsertViaBatch(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<{
    typeChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    const batch = this.batch!;
    const baseUrl = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;
    // Correlate by element INDEX, not name: names are caller-supplied and could
    // repeat, which would collapse two sub-responses onto one id.
    const idOf = (i: number): string => `e${i}`;
    const indexOf = (id: string): number => Number(id.slice(1));

    // Pass 1a — create every element. TM1 runs the batch in payload order and
    // continues past failures, so one response comes back per element.
    const created = await batch.execute(
      elements.map((el, i): BatchRequest => ({
        id: idOf(i),
        method: "POST",
        path: baseUrl,
        body: { Name: el.name, Type: el.type },
      })),
    );

    // Split the failures: "already exists" is the upsert path, anything else is
    // a genuine error that must abort the whole op (same contract as the
    // per-request path). Keep element order so the thrown error is the first
    // failure in element order, not the first to be noticed.
    const existing: number[] = [];
    for (const r of created) {
      if (r.ok) continue;
      const i = indexOf(r.id);
      if (isAlreadyExists(r.error)) existing.push(i);
      else throw r.error;
    }

    // Pass 1b — read the current Type of the elements that already existed, so
    // a type change can be reported (and skipped when it is a no-op). A failed
    // probe means "type unreadable" and falls through to the unconditional
    // PATCH below, matching the per-request path's behaviour on a NOT_FOUND.
    const probed = await batch.execute(
      existing.map((i): BatchRequest => ({
        id: idOf(i),
        method: "GET",
        path: `${baseUrl}('${enc(elements[i]!.name)}')?$select=Type`,
      })),
    );
    const typeById = new Map<number, string | null>();
    for (const r of probed) {
      // A transport/auth outage must NOT collapse into "type unreadable": that
      // would silently PATCH the type below and discard the element's leaf cell
      // values on a network blip or an expired session — and report nothing in
      // typeChanges, because an unreadable prior type yields no entry. Same
      // guard the per-request path applies to its probe; only a genuine,
      // non-systemic failure (e.g. NOT_FOUND) may degrade to null.
      if (!r.ok) rethrowIfSystemic(r.error);
      const raw = r.ok
        ? (r.body as { Type?: number | string } | null)?.Type
        : undefined;
      typeById.set(
        indexOf(r.id),
        raw === undefined || raw === null ? null : normalizeElementType(raw),
      );
    }

    // Pass 1c — patch the types that actually differ, plus the unreadable ones.
    const typeChanges: Array<{ name: string; from: string; to: string }> = [];
    const patches: BatchRequest[] = [];
    for (const i of existing) {
      const el = elements[i]!;
      const from = typeById.get(i) ?? null;
      if (from !== null && from === el.type) continue;
      patches.push({
        id: idOf(i),
        method: "PATCH",
        path: `${baseUrl}('${enc(el.name)}')`,
        body: { Type: el.type },
      });
      // A Numeric->Consolidated / Numeric->String conversion discards the
      // element's leaf cell values, so report it rather than let it happen
      // silently. An unreadable prior type yields no entry, as before.
      if (from !== null) typeChanges.push({ name: el.name, from, to: el.type });
    }
    throwFirstFailure(await batch.execute(patches), indexOf);

    // Pass barrier: every leaf write above has settled before any consolidation
    // references it via Components. Pass 1 already threw on any hard failure.
    //
    // Pass 2 — PATCH {Components:[...]} is FULL-REPLACE, not append (verified
    // live vs TM1 v11). Consolidations with no/empty components are skipped, so
    // an upsert that omits components leaves existing children intact.
    const components: BatchRequest[] = [];
    for (const [i, el] of elements.entries()) {
      if (
        el.type !== "Consolidated" ||
        !el.components ||
        el.components.length === 0
      )
        continue;
      components.push({
        id: idOf(i),
        method: "PATCH",
        path: `${baseUrl}('${enc(el.name)}')`,
        body: {
          Components: el.components.map((c) => ({
            "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
            Weight: c.weight,
          })),
        },
      });
    }
    throwFirstFailure(await batch.execute(components), indexOf);

    return { typeChanges };
  }

  /**
   * Per-request fallback for bulkUpsert, used when the server has no `$batch`.
   * Fans the calls out with bounded concurrency.
   */
  private async bulkUpsertPerRequest(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<{
    typeChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    const baseUrl = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;

    // Pass 1: Create/upsert all elements without components. Same-type element
    // writes are independent, so fan them out with bounded concurrency instead
    // of one serialized round-trip each (was 2-3N sequential calls). The cap
    // keeps constant pressure on TM1's worker pool. Each unit returns its
    // type-change (or null); we collect them index-aligned AFTER settle so
    // typeChanges stays in stable element order regardless of completion order.
    const pass1 = await mapSettledWithConcurrency(
      elements,
      BULK_UPSERT_CONCURRENCY,
      async (
        el,
      ): Promise<{ name: string; from: string; to: string } | null> => {
        const body: Record<string, unknown> = { Name: el.name, Type: el.type };
        try {
          await this.http.request<void>("POST", baseUrl, body);
          return null;
        } catch (err) {
          if (err instanceof TM1Error && isAlreadyExists(err)) {
            // Element already exists. Patch the type only when it actually
            // differs (avoids a pointless write), and surface the change: a
            // Numeric->Consolidated / Numeric->String conversion discards the
            // element's leaf cell values, so the caller must be told it happened
            // rather than have it occur silently.
            const existing = await this.http
              .request<{ Type: number | string }>(
                "GET",
                `${baseUrl}('${enc(el.name)}')?$select=Type`,
              )
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
              await this.http.request<void>(
                "PATCH",
                `${baseUrl}('${enc(el.name)}')`,
                { Type: el.type },
              );
              return { name: el.name, from, to: el.type };
            }
            if (!from) {
              // Type unreadable — preserve prior behaviour and patch unconditionally.
              await this.http.request<void>(
                "PATCH",
                `${baseUrl}('${enc(el.name)}')`,
                { Type: el.type },
              );
            }
            return null;
          }
          throw err;
        }
      },
    );

    // Pass barrier: surface the first pass-1 failure (in element order) BEFORE
    // any consolidation write. Pass 2 references leaves via Components, so it
    // must not start until every leaf has settled — concurrency is safe within
    // a pass but NOT across this barrier. Rejecting here preserves the prior
    // "bulkUpsert throws if any element failed" contract.
    const typeChanges: Array<{ name: string; from: string; to: string }> = [];
    for (const r of pass1) {
      if (r.status === "rejected") throw r.reason;
      if (r.value) typeChanges.push(r.value);
    }

    // Pass 2: Set components for consolidated elements.
    // PATCH {Components:[...]} is FULL-REPLACE, not append (verified live vs
    // TM1 v11: upserting [L3,L4] over existing [L1,L2] leaves the element with
    // exactly {L3,L4}). Consolidations with no/empty components are skipped
    // here, so an upsert that omits components leaves existing children intact
    // — only a non-empty list rewrites the child set. Documented on the tool's
    // `components` input so callers don't silently drop children. These writes
    // are mutually independent (each targets a distinct element), so they fan
    // out with the same bounded concurrency.
    const consolidated = elements.filter(
      (el) =>
        el.type === "Consolidated" && el.components && el.components.length > 0,
    );
    const pass2 = await mapSettledWithConcurrency(
      consolidated,
      BULK_UPSERT_CONCURRENCY,
      async (el): Promise<void> => {
        const path = `${baseUrl}('${enc(el.name)}')`;
        const body = {
          Components: el.components!.map((c) => ({
            "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
            Weight: c.weight,
          })),
        };
        await this.http.request<void>("PATCH", path, body);
      },
    );
    for (const r of pass2) {
      if (r.status === "rejected") throw r.reason;
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
