// Element domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements(...) — create, update,
// delete, move, bulk upsert, ElementAttribute definition CRUD, plus the
// element-attribute VALUE read/write that goes through the
// `}ElementAttributes_{Dim}` control cube. Those last two methods route
// through CellService for the underlying MDX read and cellset PATCH.
//
// See docs/ARCHITECTURE.md for the layering.
import { mapWithConcurrency } from "../../lib/concurrency.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
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
import { odataKey } from "./odata-page.js";
import { escapeMdxName, mdxString } from "../../lib/mdx.js";
import { tm1NameEquals } from "../../lib/tm1-name.js";

// Max in-flight per-element REST calls within a single bulkUpsert pass. Bounds
// pressure on TM1's worker pool (mirrors the cap the feeder-audit fan-out uses)
// while removing the serialized 2-3N round-trips on an explicitly-bulk op.
const BULK_UPSERT_CONCURRENCY = 8;

// Names per `consolidatedAmong` request. Keeps the generated $filter well
// inside any proxy URL limit while still costing one round-trip for the
// element count a normal write carries.
const CONSOLIDATED_PROBE_CHUNK = 50;

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

/** One `searchElements` match and the field whose value contained the term. */
export type ElementSearchHit = {
  name: string;
  type: string;
  level: number;
  matchedOn: string;
  matchedValue: string;
};

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
  /**
   * Set edge weights that differ from TM1's default.
   *
   * TM1 accepts `Weight` inside a Components link payload and ignores it: the
   * edge is created with weight 1 whatever the body said. Verified live — a
   * consolidation created with weight -1 read back as 1 from the Edges
   * collection itself, so no reader could have recovered the intent. The
   * weight lives on the Edge entity and has to be PATCHed once the link
   * exists.
   *
   * Only deviating weights cost a request: consolidations are overwhelmingly
   * all-1, and a PATCH that sets 1 to 1 is a round trip for nothing.
   */
  private async applyEdgeWeights(
    dimensionName: string,
    hierarchyName: string,
    parentName: string,
    components: ReadonlyArray<{ name: string; weight?: number | undefined }>,
  ): Promise<void> {
    const base = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')`;
    for (const c of components) {
      if (c.weight === undefined || c.weight === 1) continue;
      await this.http.request<void>(
        "PATCH",
        `${base}/Edges(ParentName='${odataKey(parentName)}',ComponentName='${odataKey(c.name)}')`,
        { Weight: c.weight },
      );
    }
  }

  async create(
    dimensionName: string,
    hierarchyName: string,
    element: ElementCreate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements`;
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
        "@odata.id": `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(c.name)}')`,
      }));
    }
    await this.http.request<void>("POST", path, body);
    if (element.components && element.components.length > 0) {
      await this.applyEdgeWeights(
        dimensionName,
        hierarchyName,
        element.name,
        element.components,
      );
    }
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
  ): Promise<{ typeChange: { from: string; to: string } | null }> {
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(elementName)}')`;
    // Read the prior type so an in-place conversion is reported: turning a
    // Numeric element into Consolidated/String discards its leaf cell values.
    // Same probe and outage guard as bulkUpsert; an unreadable type reports
    // nothing rather than guessing.
    let from: string | null = null;
    if (update.type !== undefined) {
      const existing = await this.http
        .request<{ Type: number | string }>("GET", `${path}?$select=Type`)
        .catch((e: unknown): null => {
          rethrowIfSystemic(e);
          return null;
        });
      from = existing ? normalizeElementType(existing.Type) : null;
    }
    const body: Record<string, unknown> = {};
    if (update.newName !== undefined) {
      body.Name = update.newName;
    }
    if (update.type !== undefined) {
      body.Type = update.type;
    }
    if (update.components !== undefined) {
      body.Components = update.components.map((c) => ({
        "@odata.id": `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(c.name)}')`,
      }));
    }
    await this.http.request<void>("PATCH", path, body);
    if (update.components !== undefined) {
      await this.applyEdgeWeights(
        dimensionName,
        hierarchyName,
        // A rename in the same PATCH takes effect immediately, so the edge
        // key must use the NEW parent name.
        update.newName ?? elementName,
        update.components,
      );
    }
    return {
      typeChange:
        from !== null && update.type !== undefined && from !== update.type
          ? { from, to: update.type }
          : null,
    };
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
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(elementName)}')`;
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
   *
   * `opts.filter` narrows the scan to names matching an OData predicate, and
   * changes what the numbers mean: the server then evaluates every element and
   * returns only the matches, so `scanned` becomes the hierarchy total (the
   * server checked all of it) and `truncated` reports a capped MATCH set
   * rather than a partial walk. That is the difference between an audit that
   * examines the first 100k names and one that examines the dimension —
   * see src/lib/naming/odata-filter.ts.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name&$orderby=Name
   */
  async scanElementNames(
    dimensionName: string,
    hierarchyName: string,
    opts: {
      pageSize: number;
      maxScan: number;
      filter?: string;
      /**
       * Hierarchy size, when the caller already knows it. With a filter the
       * response counts MATCHES, so the scope figure would otherwise cost an
       * extra request per hierarchy — and the dimension listing can carry it
       * for free via a nested $count.
       */
      scopeTotal?: number;
    },
  ): Promise<{
    names: string[];
    total: number;
    scanned: number;
    truncated: boolean;
  }> {
    const { pageSize, maxScan, filter, scopeTotal } = opts;
    const hierarchyPath = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')`;
    // $orderby is mandatory with $skip — see odata-page.ts.
    const basePath =
      `${hierarchyPath}/Elements?$select=Name&$orderby=Name&$top=${pageSize}` +
      (filter ? `&$filter=${encodeURIComponent(filter)}` : "");

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

    if (filter === undefined) {
      return {
        names,
        total,
        scanned: names.length,
        truncated: total > maxScan,
      };
    }

    // With a filter, `total` above counted the MATCHES. The caller still wants
    // to report how large the hierarchy was; when it already knows, that costs
    // nothing, otherwise one 145-byte probe.
    let inScope = scopeTotal;
    if (inScope === undefined) {
      const scopeProbe = await this.http.request<{ "@odata.count"?: number }>(
        "GET",
        `${hierarchyPath}/Elements?$select=Name&$top=0&$count=true`,
      );
      inScope = scopeProbe["@odata.count"] ?? total;
    }
    return {
      names,
      total: inScope,
      scanned: inScope,
      truncated: total > maxScan,
    };
  }

  /**
   * Type of one element, or null when the hierarchy has no such element.
   * Keyed lookup, so TM1 applies its own case- and space-insensitive name
   * matching and answers with the stored spelling.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements('{name}')?$select=Name,Type
   */
  async getType(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<{ name: string; type: string } | null> {
    try {
      const e = await this.http.request<{
        Name: string;
        Type: number | string;
      }>(
        "GET",
        `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(elementName)}')?$select=Name,Type`,
      );
      return { name: e.Name, type: normalizeElementType(e.Type) };
    } catch (err) {
      if (err instanceof TM1Error && err.code === TM1ErrorCode.NOT_FOUND) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Which of `names` are consolidated (Type 3) in this hierarchy.
   *
   * One filtered request per chunk of names rather than a GET per element:
   * the server evaluates `Type eq 3 and (Name eq ...)` and answers with the
   * hits only, so the response is bounded by the consolidations among the
   * names asked about, never by the size of the hierarchy.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name&$filter=...
   */
  async consolidatedAmong(
    dimensionName: string,
    hierarchyName: string,
    names: string[],
  ): Promise<string[]> {
    const hits: string[] = [];
    for (let i = 0; i < names.length; i += CONSOLIDATED_PROBE_CHUNK) {
      const clause = names
        .slice(i, i + CONSOLIDATED_PROBE_CHUNK)
        .map((n) => `Name eq '${n.replace(/'/g, "''")}'`)
        .join(" or ");
      const filter = encodeURIComponent(`Type eq 3 and (${clause})`);
      const page = await this.http.request<{ value: Array<{ Name: string }> }>(
        "GET",
        `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements?$select=Name&$filter=${filter}`,
      );
      for (const e of page.value) hits.push(e.Name);
    }
    return hits;
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
   * Each pass is chunked inside BatchService by request count AND serialized
   * size, so N elements cost roughly 4 * ceil(N/200) calls instead of N —
   * more when the sub-requests are large enough to hit the byte budget first.
   */
  private async bulkUpsertViaBatch(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<{
    typeChanges: Array<{ name: string; from: string; to: string }>;
  }> {
    const batch = this.batch!;
    const baseUrl = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements`;
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
        path: `${baseUrl}('${odataKey(elements[i]!.name)}')?$select=Type`,
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
        path: `${baseUrl}('${odataKey(el.name)}')`,
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
        path: `${baseUrl}('${odataKey(el.name)}')`,
        body: {
          Components: el.components.map((c) => ({
            "@odata.id": `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(c.name)}')`,
            Weight: c.weight,
          })),
        },
      });
    }
    throwFirstFailure(await batch.execute(components), indexOf);

    // Pass 3 — the weights. TM1 accepts `Weight` inside the Components link
    // above and ignores it: every edge it creates has weight 1 (measured, see
    // applyEdgeWeights). The weight lives on the Edge entity and has to be
    // PATCHed once the link exists, which is only true after pass 2. Only
    // deviating weights cost a request.
    //
    // Own id space: one element can own several edges, and a repeated id makes
    // v12 reject the whole envelope. `edgeOwner` maps each request back to the
    // element that asked for it, so a failure still names the right one.
    const edges: BatchRequest[] = [];
    const edgeOwner: number[] = [];
    for (const [i, el] of elements.entries()) {
      if (el.type !== "Consolidated" || !el.components) continue;
      for (const c of el.components) {
        if (c.weight === undefined || c.weight === 1) continue;
        edges.push({
          id: `e${edgeOwner.length}`,
          method: "PATCH",
          path: `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Edges(ParentName='${odataKey(el.name)}',ComponentName='${odataKey(c.name)}')`,
          body: { Weight: c.weight },
        });
        edgeOwner.push(i);
      }
    }
    if (edges.length > 0) {
      throwFirstFailure(
        await batch.execute(edges),
        (id) => edgeOwner[Number(id.slice(1))] ?? Number.POSITIVE_INFINITY,
      );
    }

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
    const baseUrl = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements`;

    // Pass 1: Create/upsert all elements without components. Same-type element
    // writes are independent, so fan them out with bounded concurrency instead
    // of one serialized round-trip each (was 2-3N sequential calls). The cap
    // keeps constant pressure on TM1's worker pool. Each unit returns its
    // type-change (or null); we collect them index-aligned AFTER settle so
    // typeChanges stays in stable element order regardless of completion order.
    const pass1 = await mapWithConcurrency(
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
                `${baseUrl}('${odataKey(el.name)}')?$select=Type`,
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
                `${baseUrl}('${odataKey(el.name)}')`,
                { Type: el.type },
              );
              return { name: el.name, from, to: el.type };
            }
            if (!from) {
              // Type unreadable — preserve prior behaviour and patch unconditionally.
              await this.http.request<void>(
                "PATCH",
                `${baseUrl}('${odataKey(el.name)}')`,
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
    // a pass but NOT across this barrier. Awaiting pass 1 preserves the prior
    // "bulkUpsert throws if any element failed" contract.
    const typeChanges = pass1.filter((c) => c !== null);

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
    await mapWithConcurrency(
      consolidated,
      BULK_UPSERT_CONCURRENCY,
      async (el): Promise<void> => {
        const path = `${baseUrl}('${odataKey(el.name)}')`;
        const body = {
          Components: el.components!.map((c) => ({
            "@odata.id": `Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/Elements('${odataKey(c.name)}')`,
            Weight: c.weight,
          })),
        };
        await this.http.request<void>("PATCH", path, body);
      },
    );

    // Pass 3: the weights, for the same reason as the $batch path — TM1 takes
    // `Weight` in the Components link and ignores it, so every edge lands at 1
    // until it is PATCHed on the Edge entity. Runs after pass 2 because the
    // edge has to exist first.
    await mapWithConcurrency(consolidated, BULK_UPSERT_CONCURRENCY, (el) =>
      this.applyEdgeWeights(
        dimensionName,
        hierarchyName,
        el.name,
        el.components!,
      ),
    );

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
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/ElementAttributes`;
    const response = await this.http.request<{
      value: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return response.value.map((a) => ({
      name: a.Name,
      type: a.Type as "Numeric" | "String" | "Alias",
    }));
  }

  /**
   * Case-insensitive substring search over element names, Alias attribute
   * values and the String attributes named in `stringAttributes`. OData cannot do this: `$filter`
   * on `Attributes/X` fails with error 278 ("did not resolve to a value of
   * type string") on v11, so the match runs as an MDX FILTER on the server.
   * `Cardinality` counts the whole match set while `Tuples($top)` caps what
   * comes back, so `total` is exact without fetching every match.
   *
   * Every searched attribute costs one `Properties()` per element. Measured
   * on 160,666 elements: name plus alias 0.65 s, +0.07 s per String
   * attribute; the VS Code extension saw 0.9 s for one attribute and 2.3 s
   * for all on 1.63 million. Hence Alias only by default, String attributes
   * on request; names that are not String attributes are ignored.
   *
   * POST /api/v1/ExecuteMDXSetExpression
   */
  async searchElements(
    dimensionName: string,
    hierarchyName: string,
    searchTerm: string,
    topN: number,
    stringAttributes: readonly string[] = [],
  ): Promise<{ total: number; elements: ElementSearchHit[] }> {
    type Member = {
      Name: string;
      Attributes?: Record<string, unknown>;
      Element: { Type: string; Level: number };
    };
    const attrs = (await this.listAttributes(dimensionName, hierarchyName))
      .filter(
        (a) =>
          a.type === "Alias" ||
          (a.type === "String" && stringAttributes.includes(a.name)),
      )
      .map((a) => a.name);
    const term = searchTerm.toLowerCase();
    const hierarchy = `[${escapeMdxName(dimensionName)}].[${escapeMdxName(hierarchyName)}]`;
    const member = `${hierarchy}.CurrentMember`;
    // One list drives both the server-side FILTER and the client-side report
    // of which field matched, so the two cannot drift apart.
    const fields = [
      { label: "Name", mdx: `${member}.Name`, read: (m: Member) => m.Name },
      ...attrs.map((a) => ({
        label: a,
        mdx: `${member}.Properties(${mdxString(a)})`,
        // Attributes carries only non-empty values.
        read: (m: Member) => String(m.Attributes?.[a] ?? ""),
      })),
    ];
    const tests = fields.map(
      (f) => `INSTR(1, LCASE(${f.mdx}), ${mdxString(term)}) > 0`,
    );
    const mdx = `{FILTER(TM1SUBSETALL(${hierarchy}), ${tests.join(" OR ")})}`;
    const response = await this.http.request<{
      Cardinality: number;
      Tuples: Array<{ Members: Member[] }>;
    }>(
      "POST",
      `/api/v1/ExecuteMDXSetExpression?$select=Cardinality&$expand=Tuples($top=${topN};$expand=Members($select=Name,Attributes;$expand=Element($select=Type,Level)))`,
      { MDX: mdx },
    );
    const elements = response.Tuples.map((t) => {
      const m = t.Members[0]!;
      // The server proved some field matches. If LCASE and toLowerCase
      // disagree (non-ASCII case folding), report the name rather than guess.
      const hit =
        fields.find((f) => f.read(m).toLowerCase().includes(term)) ??
        fields[0]!;
      return {
        name: m.Name,
        type: m.Element.Type,
        level: m.Element.Level,
        matchedOn: hit.label,
        matchedValue: hit.read(m),
      };
    });
    return { total: response.Cardinality, elements };
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
    const path = `/api/v1/Dimensions('${odataKey(dimensionName)}')/Hierarchies('${odataKey(hierarchyName)}')/ElementAttributes`;
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
    hierarchyName: string = dimensionName,
  ): Promise<ElementAttributeValue[]> {
    // No attribute defined means no }ElementAttributes_ cube, and the MDX
    // below would fail with a raw syntax error. Nothing to read is the answer.
    if ((await this.listAttributes(dimensionName, hierarchyName)).length === 0)
      return [];
    // Escape `]` → `]]` in every bracketed identifier: an element or dimension
    // named e.g. `Foo]` would otherwise break out of its MDX identifier and
    // shift the read onto arbitrary members (MDX injection).
    const esc = (s: string): string => s.replace(/]/g, "]]");
    const dim = esc(dimensionName);
    const elem = esc(elementName);
    const hier = esc(hierarchyName);
    const ctrlCube = `}ElementAttributes_${dim}`;
    const mdx =
      `SELECT {[}ElementAttributes_${dim}].MEMBERS} ON COLUMNS ` +
      `FROM [${ctrlCube}] ` +
      // Always name the hierarchy: the attribute cube spans every hierarchy of
      // the dimension, and v12 refuses a bare name another hierarchy shares
      // ("Member name A is ambiguous"), while v11 finds a bare name only in
      // the default hierarchy.
      `WHERE ([${dim}].[${hier}].[${elem}])`;
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
    hierarchyName: string = dimensionName,
  ): Promise<void> {
    // Check the attribute first: without it TM1 answers with a raw MDX syntax
    // error (no attribute at all means no attribute cube). TM1 matches
    // attribute names ignoring case and spaces, so compare the same way.
    const attrs = await this.listAttributes(dimensionName, hierarchyName);
    if (!attrs.some((a) => tm1NameEquals(a.name, attributeName))) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message:
          attrs.length === 0
            ? `Dimension '${dimensionName}' has no attributes; create '${attributeName}' with tm1_create_element_attribute first.`
            : `Attribute '${attributeName}' does not exist on dimension '${dimensionName}'. Existing: ${attrs.map((a) => a.name).join(", ")}.`,
      });
    }
    const ctrlCube = `}ElementAttributes_${dimensionName}`;
    const esc = (s: string): string => s.replace(/]/g, "]]");
    // Qualified for the same reason as getAttributeValues; writeCells passes a
    // `[Dim].[Hier].[Elem]` coordinate through unchanged.
    const member = `[${esc(dimensionName)}].[${esc(hierarchyName)}].[${esc(elementName)}]`;
    await this.cells.writeCells(
      ctrlCube,
      [dimensionName, `}ElementAttributes_${dimensionName}`],
      [{ elements: [member, attributeName], value }],
    );
  }
}
