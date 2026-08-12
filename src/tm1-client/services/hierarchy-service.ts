// Hierarchy domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies(...) — get, create, delete, plus the
// derived ancestors/descendants traversals that fetch a hierarchy and walk it
// client-side. See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import type { Hierarchy, HierarchyElement } from "../../types.js";
import type { TM1HttpClient } from "../http.js";
import { pageClauseList, readNestedCount } from "./odata-page.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string =>
  encodeURIComponent(String(s).replace(/'/g, "''"));

/**
 * A hierarchy plus the size of the element set the request selected, so
 * callers can page without guessing. `totalElements` counts elements that
 * survived *every* filter — the server-side `$filter` ones via
 * `Elements@odata.count`, the client-side ones (elementType, nameRegex) by
 * counting what is left after filtering. It is therefore always exact, and
 * always ≥ `elements.length`.
 */
export type HierarchyPage = Hierarchy & { totalElements: number };

export class HierarchyService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * Get a specific hierarchy with its elements, including parent/child
   * relationships. TM1 11.8 does not expose `Children` on Element, only
   * `Parents` — children are derived client-side. Filtered-out parents are
   * removed from the surviving elements' parents/children arrays to avoid
   * dangling references.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')?$expand=Elements(...)
   *
   * Paging: when no client-side post-filter is needed, `topN`/`skip` are
   * pushed into the nested Elements expand together with `$orderby=Name` and
   * `$count=true`. On a live 211k-element dimension that is 48 KB/page against
   * 67 MB for the unbounded fetch. `$orderby` is not optional — without it
   * `$skip` walks TM1's internal index order, which shifts on every element
   * create/delete and would duplicate or drop elements between pages.
   */
  async get(
    dimensionName: string,
    hierarchyName: string,
    opts?: {
      level?: number;
      levelMax?: number;
      elementType?: "Numeric" | "String" | "Consolidated" | "All";
      topN?: number;
      /**
       * Elements to skip before `topN`. Applied server-side when possible and
       * after client-side filtering otherwise, so the caller sees the same
       * pagination semantics either way.
       */
      skip?: number;
      nameContains?: string;
      nameStartsWith?: string;
      nameRegex?: string;
    },
  ): Promise<HierarchyPage> {
    const elementClauses: string[] = [
      "$select=Name,Type,Level",
      // Parents for the tree, Edges for the child weights. Both are element
      // navigations, so one request answers both — see the weight join below
      // for why the separate Edges scan is gone.
      "$expand=Parents($select=Name),Edges($select=ComponentName,Weight)",
    ];
    const filters: string[] = [];
    if (opts?.level !== undefined) filters.push(`Level eq ${opts.level}`);
    if (opts?.levelMax !== undefined) filters.push(`Level le ${opts.levelMax}`);
    const escapeOdata = (s: string) => s.replace(/'/g, "''");
    if (opts?.nameContains)
      filters.push(`contains(Name, '${escapeOdata(opts.nameContains)}')`);
    if (opts?.nameStartsWith)
      filters.push(`startswith(Name, '${escapeOdata(opts.nameStartsWith)}')`);
    // elementType pushes down as the ORDINAL, not the name: `Type eq
    // 'Consolidated'` is accepted and matches nothing — silently, which is
    // worse than an error and is why this filter used to run client-side.
    // `Type eq 3` works (verified live on 11.8: 1 → Numeric, 2 → String,
    // 3 → Consolidated).
    //
    // Doing it here matters more since elements carry their Edges: a
    // client-side type filter means fetching every element of the dimension
    // with its edges attached — measured at 99 MB on a 171k-element dimension,
    // against 300 KB for the pushed-down page.
    //
    // nameRegex stays client-side; OData has no regex.
    const TYPE_ORDINAL: Record<string, number> = {
      Numeric: 1,
      String: 2,
      Consolidated: 3,
    };
    const typeOrdinal =
      opts?.elementType && opts.elementType !== "All"
        ? TYPE_ORDINAL[opts.elementType]
        : undefined;
    if (typeOrdinal !== undefined) filters.push(`Type eq ${typeOrdinal}`);

    let regex: RegExp | undefined;
    if (opts?.nameRegex !== undefined) {
      regex = compileUserRegex(opts.nameRegex, undefined, "nameRegex");
    }
    const needsClientPostFilter = regex !== undefined;
    if (filters.length > 0)
      elementClauses.push(`$filter=${filters.join(" and ")}`);
    const skip = opts?.skip ?? 0;
    const topN = opts?.topN;
    // Push the window down only when nothing is filtered afterwards. With a
    // client post-filter active, `Elements@odata.count` would count rows the
    // caller never sees, so both the window and the total have to be computed
    // here, on the filtered set.
    const pushDown = topN !== undefined && !needsClientPostFilter;
    if (pushDown) elementClauses.push(...pageClauseList({ top: topN, skip }));

    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')?$expand=Elements(${elementClauses.join(";")})`;
    const rawResponse = await this.http.request<{
      Name: string;
      "Elements@odata.count"?: number;
      Elements: Array<{
        Name: string;
        Type: string;
        Level: number;
        Parents?: Array<{ Name: string }>;
        Edges?: Array<{ ComponentName: string; Weight: number }>;
      }>;
    }>("GET", path);
    let filteredElements = rawResponse.Elements;
    if (regex !== undefined)
      filteredElements = filteredElements.filter((e) => regex.test(e.Name));
    // Total of everything the filters kept, before the window is applied.
    // Server-side count when it was pushed down; otherwise the post-filter
    // length, which is exact because we hold the whole filtered set.
    let totalElements = pushDown
      ? (readNestedCount(rawResponse, "Elements") ??
        skip + filteredElements.length)
      : filteredElements.length;
    if (!pushDown && (skip > 0 || topN !== undefined)) {
      filteredElements = filteredElements.slice(
        skip,
        skip + (topN ?? filteredElements.length),
      );
    }
    // A count below what we already hold means the hierarchy shrank between
    // count and slice — trust the rows in hand.
    totalElements = Math.max(totalElements, skip + filteredElements.length);
    const response = { Name: rawResponse.Name, Elements: filteredElements };

    const keptNames = new Set(response.Elements.map((e) => e.Name));

    // Edge weights ride along with the elements: `Element` has an `Edges`
    // navigation carrying its OUTGOING edges — its children, with weights —
    // so the page already fetched above answers the question. Verified live:
    // every consolidated row's edges had ParentName equal to that row, and no
    // row carried an edge belonging to anything else.
    //
    // The alternative this replaces was reading the hierarchy's whole `Edges`
    // collection: 21.6 MB and 594 ms for a 171k-element dimension, against
    // 309 KB and 98 ms for the page-with-edges — one round trip instead of
    // two, and bounded by the page's fan-out rather than by the dimension.
    //
    // A missing edge still falls back to 1, TM1's default. That fallback is
    // why tests/live/dimension.live.test.ts pins a weight of -1: with 1 there
    // is no way to tell a weight that was read from one that was invented.
    const weightByEdge = new Map<string, Map<string, number>>();
    for (const e of response.Elements) {
      for (const edge of e.Edges ?? []) {
        let byChild = weightByEdge.get(e.Name);
        if (!byChild) {
          byChild = new Map<string, number>();
          weightByEdge.set(e.Name, byChild);
        }
        byChild.set(edge.ComponentName, edge.Weight);
      }
    }

    const childrenByParent = new Map<
      string,
      Array<{ name: string; weight: number }>
    >();
    for (const e of response.Elements) {
      for (const p of e.Parents ?? []) {
        if (!keptNames.has(p.Name)) continue;
        const list = childrenByParent.get(p.Name) ?? [];
        list.push({
          name: e.Name,
          weight: weightByEdge.get(p.Name)?.get(e.Name) ?? 1,
        });
        childrenByParent.set(p.Name, list);
      }
    }

    const elements: HierarchyElement[] = response.Elements.map((e) => ({
      name: e.Name,
      type: e.Type as HierarchyElement["type"],
      level: e.Level,
      parents: (e.Parents ?? [])
        .filter((p) => keptNames.has(p.Name))
        .map((p) => p.Name),
      children: childrenByParent.get(e.Name) ?? [],
    }));

    return {
      name: response.Name,
      dimensionName,
      elements,
      totalElements,
    };
  }

  /**
   * Element name + type for a whole hierarchy — nothing else.
   *
   * `get()` is the wrong tool for a type lookup: it expands `Parents` and
   * `Edges` on every element to build the tree and weight the children. This
   * reads the Elements collection directly with `$select=Name,Type` — no
   * expand at all — which is the minimum payload for name → type resolution.
   *
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Elements?$select=Name,Type
   */
  async getElementTypes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: HierarchyElement["type"] }>> {
    const path =
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')` +
      `/Elements?$select=Name,Type`;
    const response = await this.http.request<{
      value?: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return (response.value ?? []).map((e) => ({
      name: e.Name,
      type: e.Type as HierarchyElement["type"],
    }));
  }

  /**
   * Resolve descendants of a consolidation element via client-side BFS over
   * the full hierarchy. Returns a flat list with depth from the start element.
   * Reuses get() — REST traffic identical, but the LLM-facing payload is a
   * focused subtree, not the whole dimension.
   */
  async getDescendants(
    dimensionName: string,
    hierarchyName: string,
    element: string,
    opts?: { depth?: number; leavesOnly?: boolean },
  ): Promise<{
    element: string;
    descendants: Array<{
      name: string;
      type: HierarchyElement["type"];
      level: number;
      depth: number;
    }>;
  }> {
    const hierarchy = await this.get(dimensionName, hierarchyName);
    const byName = new Map<string, HierarchyElement>();
    for (const e of hierarchy.elements) byName.set(e.name, e);
    if (!byName.has(element)) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Element '${element}' not found in ${dimensionName}.${hierarchyName}`,
      });
    }
    const out: Array<{
      name: string;
      type: HierarchyElement["type"];
      level: number;
      depth: number;
    }> = [];
    const seen = new Set<string>([element]);
    const queue: Array<{ name: string; depth: number }> = [
      { name: element, depth: 0 },
    ];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const node = byName.get(cur.name);
      if (!node) continue;
      const nextDepth = cur.depth + 1;
      if (opts?.depth !== undefined && nextDepth > opts.depth) continue;
      for (const child of node.children) {
        if (seen.has(child.name)) continue;
        seen.add(child.name);
        const childNode = byName.get(child.name);
        if (!childNode) continue;
        const isLeaf = childNode.children.length === 0;
        if (!opts?.leavesOnly || isLeaf) {
          out.push({
            name: childNode.name,
            type: childNode.type,
            level: childNode.level,
            depth: nextDepth,
          });
        }
        queue.push({ name: child.name, depth: nextDepth });
      }
    }
    return { element, descendants: out };
  }

  /**
   * Resolve ancestors of an element via parent-walk. Handles multi-parent
   * hierarchies — returns the unique flat ancestor set AND every distinct
   * root-to-element path so consumers can see consolidation alternatives.
   */
  async getAncestors(
    dimensionName: string,
    hierarchyName: string,
    element: string,
  ): Promise<{
    element: string;
    ancestors: Array<{ name: string; level: number }>;
    paths: string[][];
  }> {
    const hierarchy = await this.get(dimensionName, hierarchyName);
    const byName = new Map<string, HierarchyElement>();
    for (const e of hierarchy.elements) byName.set(e.name, e);
    if (!byName.has(element)) {
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `Element '${element}' not found in ${dimensionName}.${hierarchyName}`,
      });
    }
    const ancestorMap = new Map<string, number>();
    const paths: string[][] = [];
    const walk = (
      name: string,
      currentPath: string[],
      visited: Set<string>,
    ) => {
      const node = byName.get(name);
      if (!node) return;
      const parents = node.parents;
      if (parents.length === 0) {
        paths.push([...currentPath]);
        return;
      }
      for (const parentName of parents) {
        if (visited.has(parentName)) continue;
        const parentNode = byName.get(parentName);
        if (!parentNode) continue;
        ancestorMap.set(parentName, parentNode.level);
        const nextVisited = new Set(visited);
        nextVisited.add(parentName);
        walk(parentName, [...currentPath, parentName], nextVisited);
      }
    };
    walk(element, [element], new Set([element]));
    const ancestors = [...ancestorMap.entries()]
      .map(([name, level]) => ({ name, level }))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    return { element, ancestors, paths };
  }

  /**
   * Create a new hierarchy inside an existing dimension.
   * POST /api/v1/Dimensions('{d}')/Hierarchies
   */
  async create(dimensionName: string, hierarchyName: string): Promise<void> {
    await this.http.request<void>(
      "POST",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies`,
      { Name: hierarchyName },
    );
  }

  /**
   * Delete a hierarchy from a dimension.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')
   */
  async delete(dimensionName: string, hierarchyName: string): Promise<void> {
    await this.http.request<void>(
      "DELETE",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')`,
    );
  }
}
