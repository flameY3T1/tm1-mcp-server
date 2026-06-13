// Hierarchy domain service. Owns the OData calls under
// /api/v1/Dimensions('{d}')/Hierarchies(...) — get, create, delete, plus the
// derived ancestors/descendants traversals that fetch a hierarchy and walk it
// client-side. See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type { Hierarchy, HierarchyElement } from "../../types.js";
import type { TM1HttpClient } from "../http.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

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
   */
  async get(
    dimensionName: string,
    hierarchyName: string,
    opts?: {
      level?: number;
      levelMax?: number;
      elementType?: "Numeric" | "String" | "Consolidated" | "All";
      topN?: number;
      nameContains?: string;
      nameStartsWith?: string;
      nameRegex?: string;
    },
  ): Promise<Hierarchy> {
    const elementClauses: string[] = ["$select=Name,Type,Level", "$expand=Parents($select=Name)"];
    const filters: string[] = [];
    if (opts?.level !== undefined) filters.push(`Level eq ${opts.level}`);
    if (opts?.levelMax !== undefined) filters.push(`Level le ${opts.levelMax}`);
    const escapeOdata = (s: string) => s.replace(/'/g, "''");
    if (opts?.nameContains) filters.push(`contains(Name, '${escapeOdata(opts.nameContains)}')`);
    if (opts?.nameStartsWith) filters.push(`startswith(Name, '${escapeOdata(opts.nameStartsWith)}')`);
    // elementType filter is applied client-side (TM1 OData rejects `Type eq 'Consolidated'`
    // — the property is an enum, not a string. Type filter happens before topN/server-side
    // filters because we cannot reliably express it in $filter without an enum-cast that
    // varies between TM1 versions.) Same for nameRegex (regex unsupported in OData).
    // When either is set, $top must also move client-side.
    const filterByType = opts?.elementType && opts.elementType !== "All";
    let regex: RegExp | undefined;
    if (opts?.nameRegex !== undefined) {
      try {
        regex = new RegExp(opts.nameRegex);
      } catch (e) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Invalid nameRegex: ${(e as Error).message}`,
        });
      }
    }
    const needsClientPostFilter = filterByType || regex !== undefined;
    if (filters.length > 0) elementClauses.push(`$filter=${filters.join(" and ")}`);
    if (opts?.topN !== undefined && !needsClientPostFilter) elementClauses.push(`$top=${opts.topN}`);

    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')?$expand=Elements(${elementClauses.join(";")})`;
    const rawResponse = await this.http.request<{
      Name: string;
      Elements: Array<{
        Name: string;
        Type: string;
        Level: number;
        Parents?: Array<{ Name: string }>;
      }>;
    }>("GET", path);

    let filteredElements = rawResponse.Elements;
    if (filterByType) filteredElements = filteredElements.filter((e) => e.Type === opts!.elementType);
    if (regex !== undefined) filteredElements = filteredElements.filter((e) => regex!.test(e.Name));
    if (needsClientPostFilter && opts?.topN !== undefined) {
      filteredElements = filteredElements.slice(0, opts.topN);
    }
    const response = { Name: rawResponse.Name, Elements: filteredElements };

    const keptNames = new Set(response.Elements.map((e) => e.Name));
    const childrenByParent = new Map<string, Array<{ name: string; weight: number }>>();
    for (const e of response.Elements) {
      for (const p of e.Parents ?? []) {
        if (!keptNames.has(p.Name)) continue;
        const list = childrenByParent.get(p.Name) ?? [];
        list.push({ name: e.Name, weight: 1 });
        childrenByParent.set(p.Name, list);
      }
    }

    const elements: HierarchyElement[] = response.Elements.map((e) => ({
      name: e.Name,
      type: e.Type as HierarchyElement["type"],
      level: e.Level,
      parents: (e.Parents ?? []).filter((p) => keptNames.has(p.Name)).map((p) => p.Name),
      children: childrenByParent.get(e.Name) ?? [],
    }));

    return {
      name: response.Name,
      dimensionName,
      elements,
    };
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
    descendants: Array<{ name: string; type: HierarchyElement["type"]; level: number; depth: number }>;
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
    const out: Array<{ name: string; type: HierarchyElement["type"]; level: number; depth: number }> = [];
    const seen = new Set<string>([element]);
    const queue: Array<{ name: string; depth: number }> = [{ name: element, depth: 0 }];
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
          out.push({ name: childNode.name, type: childNode.type, level: childNode.level, depth: nextDepth });
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
    const walk = (name: string, currentPath: string[], visited: Set<string>) => {
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
