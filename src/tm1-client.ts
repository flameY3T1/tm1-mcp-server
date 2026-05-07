import { TM1Error, TM1ErrorCode } from "./types.js";
import type { Cube, Dimension, Hierarchy, HierarchyElement, Process, ProcessParameter, ProcessVariable, ProcessResult, ProcessCode, DataSource, Chore, CellValue, MdxResult, MdxAxis, ViewResult, ViewDefinition, ElementCreate, ElementUpdate, Thread, MessageLogEntry, CubeRules, ChoreCreate, ServerInfo, CompileResult, ProcessCheckInput, CubeView, TransactionLogEntry, Subset, SubsetCreate, ElementAttributeValue, Client, ClientCreate, ClientUpdate, Group, Session, RuleSyntaxError, ErrorLogFile } from "./types.js";
import { TM1HttpClient } from "./tm1-client/http.js";

export class TM1Client extends TM1HttpClient {
  private connected = false;

  /**
   * Authenticate and start the keep-alive timer.
   */
  async connect(): Promise<void> {
    this.logger.info("Connecting to TM1 server");
    await this.sessionManager.authenticate();
    this.sessionManager.startKeepAlive();
    this.connected = true;
    this.logger.info("Connected to TM1 server");
  }

  /**
   * Stop the keep-alive timer and mark as disconnected.
   */
  async disconnect(): Promise<void> {
    this.logger.info("Disconnecting from TM1 server");
    this.sessionManager.stopKeepAlive();
    await this.sessionManager.logout();
    this.connected = false;
    this.logger.info("Disconnected from TM1 server");
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Metadata methods ──────────────────────────────────────────────────────

  /**
   * List all cubes with their dimension names.
   * GET /api/v1/Cubes?$expand=Dimensions($select=Name)
   *
   * opts.includeRules adds Rules text to the OData $select so we can
   * derive hasRules per cube in a single round-trip (no N+1).
   */
  async getCubes(opts: { includeRules?: boolean } = {}): Promise<Cube[]> {
    const path = opts.includeRules
      ? "/api/v1/Cubes?$select=Name,Rules&$expand=Dimensions($select=Name)"
      : "/api/v1/Cubes?$expand=Dimensions($select=Name)";
    const response = await this.request<{
      value: Array<{ Name: string; Rules?: string; Dimensions: Array<{ Name: string }> }>;
    }>("GET", path);
    return response.value.map((c) => {
      const cube: Cube = {
        name: c.Name,
        dimensions: c.Dimensions.map((d) => d.Name),
      };
      if (opts.includeRules) {
        cube.hasRules = !!(c.Rules && c.Rules.trim().length > 0);
      }
      return cube;
    });
  }

  /**
   * List all dimensions with their hierarchy names.
   * GET /api/v1/Dimensions?$expand=Hierarchies($select=Name)
   */
  async getDimensions(): Promise<Dimension[]> {
    const response = await this.request<{ value: Array<{ Name: string; Hierarchies: Array<{ Name: string }> }> }>(
      "GET",
      "/api/v1/Dimensions?$expand=Hierarchies($select=Name)",
    );
    return response.value.map((d) => ({
      name: d.Name,
      hierarchies: d.Hierarchies.map((h) => h.Name),
    }));
  }

  /**
   * Get a specific hierarchy with its elements, including parent/child relationships.
   * GET /api/v1/Dimensions('{dimensionName}')/Hierarchies('{hierarchyName}')?$expand=Elements(...)
   *
   * Optional opts apply server-side filters (level, levelMax, elementType) and topN
   * truncation. Filtered-out elements are removed from parents/children arrays of
   * remaining elements to avoid dangling references.
   */
  async getHierarchy(
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
    // TM1 11.8 does not expose `Children` on Element — only `Parents`. Fetch Parents
    // and derive children server-side. Weight defaults to 1 (actual weights live on
    // /Edges; not fetched here to keep the query cheap).
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

    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')?$expand=Elements(${elementClauses.join(";")})`;
    const rawResponse = await this.request<{
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
   * Reuses getHierarchy() — REST traffic identical, but the LLM-facing payload
   * is a focused subtree, not the whole dimension.
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
    const hierarchy = await this.getHierarchy(dimensionName, hierarchyName);
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
    const hierarchy = await this.getHierarchy(dimensionName, hierarchyName);
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
   * List all TI processes with their parameters.
   * GET /api/v1/Processes?$expand=Parameters
   */
  async getProcesses(): Promise<Process[]> {
    // Parameters is a structural (complex) property, not a navigation property
    // — TM1 v11 rejects $expand=Parameters with a syntax error. Use $select
    // instead, which returns Parameters inline. Param.Type comes back as the
    // already-decoded string "Numeric" / "String" (not the legacy int code).
    try {
      const response = await this.request<{
        value: Array<{
          Name: string;
          Parameters?: Array<{
            Name: string;
            Type: string;
            Value: string | number;
            Prompt?: string;
          }>;
        }>;
      }>("GET", "/api/v1/Processes?$select=Name,Parameters");

      return response.value.map((p) => ({
        name: p.Name,
        parameters: (p.Parameters ?? []).map((param): ProcessParameter => ({
          name: param.Name,
          type: param.Type === "Numeric" ? "Numeric" : "String",
          defaultValue: param.Value,
          ...(param.Prompt ? { prompt: param.Prompt } : {}),
        })),
      }));
    } catch {
      const response = await this.request<{
        value: Array<{ Name: string }>;
      }>("GET", "/api/v1/Processes?$select=Name");

      return response.value.map((p) => ({
        name: p.Name,
        parameters: [],
      }));
    }
  }

  /**
   * List all chores with their tasks.
   * GET /api/v1/Chores?$expand=Tasks
   */
  async getChores(): Promise<Chore[]> {
    // Expand Process inside Tasks — without it, Task.Process is omitted and the map
    // below sees undefined for every task.
    const response = await this.request<{
      value: Array<{
        Name: string;
        Active: boolean;
        StartTime: string;
        DSTSensitive: boolean;
        Frequency: string;
        Tasks?: Array<{
          Step: number;
          Parameters?: Array<{ Name: string; Value: string | number }>;
          Process?: { Name: string };
        }>;
      }>;
    }>("GET", "/api/v1/Chores?$expand=Tasks($expand=Process($select=Name))");

    return response.value.map((ch) => ({
      name: ch.Name,
      active: ch.Active,
      startTime: ch.StartTime,
      frequency: ch.Frequency,
      processes: (ch.Tasks ?? []).map((t) => ({
        name: t.Process?.Name ?? "<unknown>",
        parameters: Object.fromEntries(
          (t.Parameters ?? []).map((p) => [p.Name, p.Value]),
        ),
      })),
    }));
  }

  // ── Cell data methods ────────────────────────────────────────────────────

  /**
   * Get a single cell value via a 1-tuple MDX query.
   *
   * TM1 11.8 returns 0 cells for `SELECT {} ON COLUMNS WHERE (...)` — the
   * empty axis collapses the cellset. Put the first element on COLUMNS and
   * the rest in WHERE to force a 1-cell cellset.
   */
  async getCellValue(cubeName: string, elements: string[]): Promise<CellValue> {
    if (elements.length === 0) {
      return null;
    }

    // Qualify each element with its dimension. Plain `[Element]` MDX is
    // ambiguous when the same name exists in multiple dimensions (common in
    // control cubes like `}ElementAttributes_*`, where attribute member
    // `DisplayName` collides with the attribute dimension's element of the
    // same name) and TM1 returns rte 77 "object not found".
    const cubePath = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')?$expand=Dimensions($select=Name)`;
    const cubeMeta = await this.request<{ Name: string; Dimensions: Array<{ Name: string }> }>(
      "GET",
      cubePath,
    );
    const dims = cubeMeta.Dimensions.map((d) => d.Name);
    if (elements.length !== dims.length) {
      throw new Error(
        `Cube '${cubeName}' has ${dims.length} dimension(s) (${dims.join(", ")}) but ${elements.length} element(s) were given`,
      );
    }
    const qualify = (dim: string, element: string): string => {
      // Pre-qualified MDX member reference — pass through.
      if (element.startsWith("[") && element.includes("].[")) return element;
      // Single bracketed member like `[Foo]` — prepend dimension.
      if (element.startsWith("[") && element.endsWith("]")) return `[${dim}].${element}`;
      return `[${dim}].[${element}]`;
    };
    const qualified = dims.map((d, i) => qualify(d, elements[i]));

    const colMember = qualified[0];
    const whereParts = qualified.slice(1);
    const mdx =
      whereParts.length === 0
        ? `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}]`
        : `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}] WHERE (${whereParts.join(",")})`;

    const cellsetResponse = await this.request<{
      ID: string;
      Cells?: Array<{ Value: CellValue; FormattedValue: string }>;
    }>("POST", "/api/v1/ExecuteMDX?$expand=Cells($select=Value,FormattedValue)", { MDX: mdx });

    if (cellsetResponse.Cells && cellsetResponse.Cells.length > 0) {
      return cellsetResponse.Cells[0].Value;
    }

    return null;
  }

  /**
   * Return ordered dimension-name list of a cube.
   * GET /api/v1/Cubes('{name}')?$expand=Dimensions($select=Name)
   */
  async getCubeDimensionNames(cubeName: string): Promise<string[]> {
    const path = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')?$expand=Dimensions($select=Name)`;
    const response = await this.request<{ Name: string; Dimensions: Array<{ Name: string }> }>(
      "GET",
      path,
    );
    return response.Dimensions.map((d) => d.Name);
  }

  /**
   * Execute an MDX query and return structured results with cells and axes.
   * Supports pagination via optional top/skip parameters on the Cells expand.
   */
  async executeMdx(mdx: string, top?: number, skip?: number): Promise<MdxResult> {
    // Build the $expand for Cells with optional pagination
    let cellsExpand = "Cells($select=Value,FormattedValue";
    if (top !== undefined) {
      cellsExpand += `;$top=${top}`;
    }
    if (skip !== undefined) {
      cellsExpand += `;$skip=${skip}`;
    }
    cellsExpand += ")";

    const axesExpand = "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
    const path = `/api/v1/ExecuteMDX?$expand=${cellsExpand},${axesExpand}`;

    const response = await this.request<{
      ID: string;
      Cells: Array<{ Value: CellValue; FormattedValue: string }>;
      Axes: Array<{
        Tuples: Array<{
          Members: Array<{
            Name: string;
            Hierarchy: { Name: string };
          }>;
        }>;
      }>;
    }>("POST", path, { MDX: mdx });

    return this.transformCellsetResponse(response);
  }

  /**
   * Execute a named view and return structured results.
   * POST /api/v1/Cubes('{cubeName}')/Views('{viewName}')/tm1.Execute
   */
  async getView(cubeName: string, viewName: string): Promise<ViewResult> {
    const axesExpand = "Axes($expand=Tuples($expand=Members($select=Name;$expand=Hierarchy($select=Name))))";
    const path = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')/Views('${encodeURIComponent(viewName)}')/tm1.Execute?$expand=Cells($select=Value,FormattedValue),${axesExpand}`;

    const response = await this.request<{
      ID: string;
      Cells: Array<{ Value: CellValue; FormattedValue: string }>;
      Axes: Array<{
        Tuples: Array<{
          Members: Array<{
            Name: string;
            Hierarchy: { Name: string };
          }>;
        }>;
      }>;
    }>("POST", path);

    const mdxResult = this.transformCellsetResponse(response);

    return {
      cubeName,
      viewName,
      cells: mdxResult.cells,
      axes: mdxResult.axes,
    };
  }

  /**
   * Return the structural definition of a view (MDX expression OR native axes)
   * WITHOUT executing it. Auto-falls back from public to private when isPrivate
   * is undefined.
   * GET /api/v1/Cubes('X')/Views('Y') with tm1.NativeView/* expands.
   */
  async getViewDefinition(
    cubeName: string,
    viewName: string,
    isPrivate?: boolean,
  ): Promise<ViewDefinition> {
    const enc = encodeURIComponent;

    type RawSubset = {
      Name?: string;
      Expression?: string;
      Hierarchy?: { Name?: string; Dimension?: { Name?: string } };
    };
    type RawAxis = { Subset?: RawSubset };
    type RawTitle = RawAxis & { Selected?: { Name?: string } };
    type RawBase = { Name: string; MDX?: string | null };
    type RawNative = {
      Titles?: RawTitle[];
      Columns?: RawAxis[];
      Rows?: RawAxis[];
    };

    const fetchBase = async (
      segment: "Views" | "PrivateViews",
    ): Promise<RawBase> => {
      const path = `/api/v1/Cubes('${enc(cubeName)}')/${segment}('${enc(viewName)}')?$select=Name,MDX`;
      return this.request<RawBase>("GET", path);
    };

    const order: Array<{ seg: "Views" | "PrivateViews"; priv: boolean }> =
      isPrivate === true
        ? [{ seg: "PrivateViews", priv: true }]
        : isPrivate === false
          ? [{ seg: "Views", priv: false }]
          : [
              { seg: "Views", priv: false },
              { seg: "PrivateViews", priv: true },
            ];

    let base: RawBase | null = null;
    let resolvedSeg: "Views" | "PrivateViews" = "Views";
    let resolvedPrivate = false;
    let lastErr: unknown = null;
    for (const { seg, priv } of order) {
      try {
        base = await fetchBase(seg);
        resolvedSeg = seg;
        resolvedPrivate = priv;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!base) {
      if (lastErr instanceof TM1Error) throw lastErr;
      throw new TM1Error({
        code: TM1ErrorCode.NOT_FOUND,
        message: `View not found: ${cubeName}/${viewName}`,
        endpoint: `/api/v1/Cubes('${cubeName}')/Views('${viewName}')`,
      });
    }

    const isMdx = typeof base.MDX === "string" && base.MDX.length > 0;
    if (isMdx) {
      return {
        cubeName,
        viewName,
        private: resolvedPrivate,
        type: "MDX",
        mdx: base.MDX as string,
      };
    }

    const subsetExpand =
      "Subset($select=Name,Expression;$expand=Hierarchy($select=Name;$expand=Dimension($select=Name)))";
    const nativeExpand =
      `Titles($expand=${subsetExpand},Selected($select=Name)),` +
      `Columns($expand=${subsetExpand}),` +
      `Rows($expand=${subsetExpand})`;
    const nativePath = `/api/v1/Cubes('${enc(cubeName)}')/${resolvedSeg}('${enc(viewName)}')/tm1.NativeView?$expand=${nativeExpand}`;

    let native: RawNative;
    try {
      native = await this.request<RawNative>("GET", nativePath);
    } catch (e) {
      if (e instanceof TM1Error && e.httpStatus === 404) {
        return {
          cubeName,
          viewName,
          private: resolvedPrivate,
          type: "Native",
          native: { titles: [], columns: [], rows: [] },
        };
      }
      throw e;
    }

    const mapAxis = (a: RawAxis) => {
      const s = a.Subset ?? {};
      return {
        dimensionName: s.Hierarchy?.Dimension?.Name,
        hierarchyName: s.Hierarchy?.Name,
        subsetName: s.Name && s.Name.length > 0 ? s.Name : undefined,
        expression: s.Expression && s.Expression.length > 0 ? s.Expression : undefined,
      };
    };
    const mapTitle = (t: RawTitle) => ({
      ...mapAxis(t),
      selectedElement: t.Selected?.Name,
    });

    return {
      cubeName,
      viewName,
      private: resolvedPrivate,
      type: "Native",
      native: {
        titles: (native.Titles ?? []).map(mapTitle),
        columns: (native.Columns ?? []).map(mapAxis),
        rows: (native.Rows ?? []).map(mapAxis),
      },
    };
  }

  /**
   * Transform a raw TM1 cellset API response into the structured MdxResult model.
   */
  private transformCellsetResponse(response: {
    Cells: Array<{ Value: CellValue; FormattedValue: string }>;
    Axes: Array<{
      Tuples: Array<{
        Members: Array<{
          Name: string;
          Hierarchy: { Name: string };
        }>;
      }>;
    }>;
  }): MdxResult {
    const cells = (response.Cells ?? []).map((c) => ({
      value: c.Value,
      formattedValue: c.FormattedValue,
    }));

    const axes: MdxAxis[] = (response.Axes ?? []).map((axis) => ({
      tuples: axis.Tuples.map((tuple) => ({
        members: tuple.Members.map((m) => ({
          name: m.Name,
          hierarchyName: m.Hierarchy.Name,
        })),
      })),
    }));

    // totalCellCount: product of tuple counts across all axes, or cell count if no axes
    const totalCellCount =
      axes.length > 0
        ? axes.reduce((acc, axis) => acc * axis.tuples.length, 1)
        : cells.length;

    return { cells, axes, totalCellCount };
  }

  // ── Process execution methods ──────────────────────────────────────────────

  /**
   * Execute a TI process with optional parameters.
   * POST /api/v1/Processes('{processName}')/tm1.Execute
   */
  async executeProcess(
    processName: string,
    params?: Record<string, string | number>,
  ): Promise<ProcessResult> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')/tm1.Execute`;

    const body: { Parameters?: Array<{ Name: string; Value: string | number }> } = {};
    if (params && Object.keys(params).length > 0) {
      body.Parameters = Object.entries(params).map(([name, value]) => ({
        Name: name,
        Value: value,
      }));
    }

    try {
      await this.request<void>("POST", path, body);
      return {
        success: true,
        processErrorStatus: "CompletedSuccessfully",
      };
    } catch (error) {
      if (error instanceof TM1Error) {
        return {
          success: false,
          processErrorStatus: error.details ?? error.message,
          errorLogFile: undefined,
        };
      }
      throw error;
    }
  }

  /**
   * Get the parameters of a TI process.
   * GET /api/v1/Processes('{processName}')/Parameters
   */
  async getProcessParameters(processName: string): Promise<ProcessParameter[]> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')/Parameters`;

    // TM1 v11 returns Type as the decoded string "Numeric" / "String"
    // (not the legacy int code 1 / 2). The old `=== 1` check silently
    // classified every Numeric parameter as String.
    const response = await this.request<{
      value: Array<{
        Name: string;
        Type: string;
        Value: string | number;
        Prompt?: string;
      }>;
    }>("GET", path);

    return response.value.map((param): ProcessParameter => ({
      name: param.Name,
      type: param.Type === "Numeric" ? "Numeric" : "String",
      defaultValue: param.Value,
      ...(param.Prompt ? { prompt: param.Prompt } : {}),
    }));
  }

  // ── TI development methods ──────────────────────────────────────────────

  /**
   * Create a new empty TI process.
   * POST /api/v1/Processes with body {"Name": "..."}
   * Throws CONFLICT (409) if a process with the same name already exists.
   */
  async createProcess(name: string): Promise<void> {
    await this.request<void>("POST", "/api/v1/Processes", { Name: name });
  }

  async copyProcess(sourceName: string, targetName: string): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(sourceName)}')`;
    const source = await this.request<Record<string, unknown>>("GET", path);
    // Remove read-only / server-managed fields
    delete source["@odata.context"];
    delete source["@odata.etag"];
    delete source["Attributes"];
    delete source["LocalizedAttributes"];
    source.Name = targetName;
    await this.request<void>("POST", "/api/v1/Processes", source);
  }

  /**
   * Fetch every TI process with code AND parameter metadata for callgraph
   * indexing. Single round trip; falls back through 4 OData variants for
   * older/strict TM1 versions.
   */
  async fetchProcessesForCallgraph(includeControl = false): Promise<Array<{
    name: string;
    prolog: string;
    metadata: string;
    data: string;
    epilog: string;
    parameters: string[];
    parameterDefaults: Map<string, string>;
  }>> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const urls = [
      `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,Parameters${filter}`,
      `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,Parameters&$expand=Parameters($select=Name,Value,Type)${filter}`,
      `/api/v1/Processes?$expand=Parameters${filter}`,
      `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure${filter}`,
    ];
    type Raw = {
      Name?: string;
      PrologProcedure?: string;
      MetadataProcedure?: string;
      DataProcedure?: string;
      EpilogProcedure?: string;
      Parameters?: Array<{ Name?: string; Value?: string | number; Type?: string | number }>;
    };
    let body: { value: Raw[] } | undefined;
    let lastErr: unknown;
    for (const u of urls) {
      try {
        body = await this.request<{ value: Raw[] }>("GET", u);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!body) throw lastErr ?? new Error("Processes fetch failed");
    return (body.value ?? []).map((p) => {
      const parameters = (p.Parameters ?? [])
        .map((x) => String(x.Name ?? ""))
        .filter((n) => n !== "");
      const parameterDefaults = new Map<string, string>();
      for (const x of p.Parameters ?? []) {
        if (x.Name && x.Value !== undefined && x.Value !== null && x.Value !== "") {
          parameterDefaults.set(String(x.Name), String(x.Value));
        }
      }
      return {
        name: String(p.Name ?? ""),
        prolog: String(p.PrologProcedure ?? ""),
        metadata: String(p.MetadataProcedure ?? ""),
        data: String(p.DataProcedure ?? ""),
        epilog: String(p.EpilogProcedure ?? ""),
        parameters,
        parameterDefaults,
      };
    }).filter((p) => p.name !== "");
  }

  /**
   * Bulk-fetch code for every TI process in a single round trip.
   * GET /api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure
   * Control processes (Name starts with `}`) excluded unless includeControl=true.
   */
  async getAllProcessesCode(includeControl = false): Promise<Array<ProcessCode & { name: string }>> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const path = `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure${filter}`;
    const response = await this.request<{
      value: Array<{
        Name: string;
        PrologProcedure: string;
        MetadataProcedure: string;
        DataProcedure: string;
        EpilogProcedure: string;
      }>;
    }>("GET", path);
    return response.value.map((p) => ({
      name: p.Name,
      prolog: p.PrologProcedure ?? "",
      metadata: p.MetadataProcedure ?? "",
      data: p.DataProcedure ?? "",
      epilog: p.EpilogProcedure ?? "",
    }));
  }

  /**
   * Get the code of all four tabs of a TI process.
   * GET /api/v1/Processes('{name}')
   */
  async getProcessCode(processName: string): Promise<ProcessCode> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    const response = await this.request<{
      PrologProcedure: string;
      MetadataProcedure: string;
      DataProcedure: string;
      EpilogProcedure: string;
    }>("GET", path);

    return {
      prolog: response.PrologProcedure,
      metadata: response.MetadataProcedure,
      data: response.DataProcedure,
      epilog: response.EpilogProcedure,
    };
  }

  /**
   * Update one or more code tabs of a TI process (partial update).
   * PATCH /api/v1/Processes('{name}') with only the tabs to update.
   */
  async updateProcessCode(processName: string, code: Partial<ProcessCode>): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    const body: Record<string, string> = {};
    if (code.prolog !== undefined) body.PrologProcedure = code.prolog;
    if (code.metadata !== undefined) body.MetadataProcedure = code.metadata;
    if (code.data !== undefined) body.DataProcedure = code.data;
    if (code.epilog !== undefined) body.EpilogProcedure = code.epilog;

    await this.request<void>("PATCH", path, body);
  }

  /**
   * Get the data source configuration of a TI process.
   * GET /api/v1/Processes('{name}') and extract the DataSource field.
   */
  async getProcessDataSource(processName: string): Promise<DataSource> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    const response = await this.request<{
      DataSource: {
        Type: string;
        dataSourceNameForServer?: string;
        dataSourceNameForClient?: string;
        asciiDelimiterType?: string;
        asciiDelimiterChar?: string;
        asciiQuoteCharacter?: string;
        asciiHeaderRecords?: number;
        asciiDecimalSeparator?: string;
        asciiThousandSeparator?: string;
        usesUnicode?: boolean;
        userName?: string;
        password?: string;
        oDBCConnection?: string;
        query?: string;
        view?: string;
        subset?: string;
      };
    }>("GET", path);

    const ds = response.DataSource;
    return {
      type: ds.Type as DataSource["type"],
      ...(ds.dataSourceNameForServer !== undefined ? { dataSourceNameForServer: ds.dataSourceNameForServer } : {}),
      ...(ds.dataSourceNameForClient !== undefined ? { dataSourceNameForClient: ds.dataSourceNameForClient } : {}),
      ...(ds.asciiDelimiterType !== undefined ? { asciiDelimiterType: ds.asciiDelimiterType } : {}),
      ...(ds.asciiDelimiterChar !== undefined ? { asciiDelimiterChar: ds.asciiDelimiterChar } : {}),
      ...(ds.asciiQuoteCharacter !== undefined ? { asciiQuoteCharacter: ds.asciiQuoteCharacter } : {}),
      ...(ds.asciiHeaderRecords !== undefined ? { asciiHeaderRecords: ds.asciiHeaderRecords } : {}),
      ...(ds.asciiDecimalSeparator !== undefined ? { asciiDecimalSeparator: ds.asciiDecimalSeparator } : {}),
      ...(ds.asciiThousandSeparator !== undefined ? { asciiThousandSeparator: ds.asciiThousandSeparator } : {}),
      ...(ds.usesUnicode !== undefined ? { usesUnicode: ds.usesUnicode } : {}),
      ...(ds.userName !== undefined ? { userName: ds.userName } : {}),
      ...(ds.password !== undefined ? { password: ds.password } : {}),
      ...(ds.oDBCConnection !== undefined ? { oDBCConnection: ds.oDBCConnection } : {}),
      ...(ds.query !== undefined ? { query: ds.query } : {}),
      ...(ds.view !== undefined ? { view: ds.view } : {}),
      ...(ds.subset !== undefined ? { subset: ds.subset } : {}),
    };
  }

  /**
   * Update the data source configuration of a TI process.
   * PATCH /api/v1/Processes('{name}') with DataSource object.
   */
  async updateProcessDataSource(processName: string, dataSource: DataSource): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    const dsBody: Record<string, unknown> = { Type: dataSource.type };
    if (dataSource.dataSourceNameForServer !== undefined) dsBody.dataSourceNameForServer = dataSource.dataSourceNameForServer;
    if (dataSource.dataSourceNameForClient !== undefined) dsBody.dataSourceNameForClient = dataSource.dataSourceNameForClient;
    if (dataSource.asciiDelimiterType !== undefined) dsBody.asciiDelimiterType = dataSource.asciiDelimiterType;
    if (dataSource.asciiDelimiterChar !== undefined) dsBody.asciiDelimiterChar = dataSource.asciiDelimiterChar;
    if (dataSource.asciiQuoteCharacter !== undefined) dsBody.asciiQuoteCharacter = dataSource.asciiQuoteCharacter;
    if (dataSource.asciiHeaderRecords !== undefined) dsBody.asciiHeaderRecords = dataSource.asciiHeaderRecords;
    if (dataSource.asciiDecimalSeparator !== undefined) dsBody.asciiDecimalSeparator = dataSource.asciiDecimalSeparator;
    if (dataSource.asciiThousandSeparator !== undefined) dsBody.asciiThousandSeparator = dataSource.asciiThousandSeparator;
    if (dataSource.usesUnicode !== undefined) {
      if (this.config.tm1Version.startsWith("11")) {
        this.logger.warn(
          { processName, tm1Version: this.config.tm1Version },
          "DataSource.usesUnicode is v12-only and is being dropped from the PATCH (TM1 11.x rejects it as 'unprocessed properties')",
        );
      } else {
        dsBody.usesUnicode = dataSource.usesUnicode;
      }
    }
    if (dataSource.userName !== undefined) dsBody.userName = dataSource.userName;
    if (dataSource.password !== undefined) dsBody.password = dataSource.password;
    if (dataSource.oDBCConnection !== undefined) dsBody.oDBCConnection = dataSource.oDBCConnection;
    if (dataSource.query !== undefined) dsBody.query = dataSource.query;
    if (dataSource.view !== undefined) dsBody.view = dataSource.view;
    if (dataSource.subset !== undefined) dsBody.subset = dataSource.subset;

    await this.request<void>("PATCH", path, { DataSource: dsBody });
  }

  /**
   * Get the variables (column-mapped names) of a TI process.
   * GET /api/v1/Processes('{name}')/Variables
   */
  async getProcessVariables(processName: string): Promise<ProcessVariable[]> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')/Variables`;
    const response = await this.request<{
      value: Array<{
        Name: string;
        Type: string;
        Position: number;
        StartByte?: number;
        EndByte?: number;
      }>;
    }>("GET", path);

    return response.value.map((v): ProcessVariable => ({
      name: v.Name,
      type: v.Type === "Numeric" ? "Numeric" : "String",
      position: v.Position,
      ...(v.StartByte !== undefined ? { startByte: v.StartByte } : {}),
      ...(v.EndByte !== undefined ? { endByte: v.EndByte } : {}),
    }));
  }

  /**
   * Update the variables of a TI process (column-name mapping for ASCII/ODBC sources).
   * PATCH /api/v1/Processes('{name}') with Variables array.
   * Required after setting an ASCII DataSource because the MCP-side code
   * cannot rely on TM1 auto-deriving column names without a UI save.
   */
  async updateProcessVariables(processName: string, vars: ProcessVariable[]): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    const body = {
      Variables: vars.map((v) => ({
        Name: v.name,
        Type: v.type,
        Position: v.position,
        StartByte: v.startByte ?? 0,
        EndByte: v.endByte ?? 0,
      })),
    };
    await this.request<void>("PATCH", path, body);
  }

  /**
   * Update the parameters of a TI process.
   * PATCH /api/v1/Processes('{name}') with Parameters array.
   */
  async updateProcessParameters(processName: string, params: ProcessParameter[]): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    // FIXME: write-direction Type encoding is INVERTED relative to OData metadata
    // (tm1.ProcessVariableType maps String=1, Numeric=2 — opposite of below).
    // TM1 v11 currently accepts both because of enum coercion leniency, but
    // this could silently mis-classify params. Tracked for follow-up; needs
    // a live PATCH+read roundtrip test before the safer string-name encoding
    // can be shipped without behavior risk.
    const body = {
      Parameters: params.map((p) => ({
        Name: p.name,
        Type: p.type === "Numeric" ? 1 : 2,
        Value: p.defaultValue,
        ...(p.prompt ? { Prompt: p.prompt } : {}),
      })),
    };

    await this.request<void>("PATCH", path, body);
  }

  /**
   * Delete a TI process.
   * DELETE /api/v1/Processes('{name}')
   */
  async deleteProcess(processName: string): Promise<void> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')`;
    await this.request<void>("DELETE", path);
  }

  // ── Dimension management methods ────────────────────────────────────────

  /**
   * Create a new element in a hierarchy.
   * POST /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/Elements
   */
  async createElement(
    dimensionName: string,
    hierarchyName: string,
    element: ElementCreate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements`;

    const body: Record<string, unknown> = {
      Name: element.name,
      Type: element.type,
    };

    if (element.type === "Consolidated" && element.components && element.components.length > 0) {
      body.Components = element.components.map((c) => ({
        "@odata.id": `Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(c.name)}')`,
        Weight: c.weight,
      }));
    }

    await this.request<void>("POST", path, body);
  }

  /**
   * Update an existing element in a hierarchy (name, type, or components).
   * PATCH /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/Elements('{name}')
   */
  async updateElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    update: ElementUpdate,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(elementName)}')`;

    const body: Record<string, unknown> = {};
    if (update.newName !== undefined) {
      body.Name = update.newName;
    }
    if (update.type !== undefined) {
      body.Type = update.type;
    }
    if (update.components !== undefined) {
      body.Components = update.components.map((c) => ({
        "@odata.id": `Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(c.name)}')`,
        Weight: c.weight,
      }));
    }

    await this.request<void>("PATCH", path, body);
  }

  /**
   * Delete an element from a hierarchy.
   * DELETE /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/Elements('{name}')
   * May throw an error if the element is referenced in rules.
   */
  async deleteElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(elementName)}')`;
    await this.request<void>("DELETE", path);
  }

  /**
   * Move an element to a new parent within a hierarchy by adding it as a component
   * of the new parent element.
   * POST /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/Elements('{newParent}')/Components
   */
  async moveElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    newParent: string,
    weight?: number,
  ): Promise<void> {
    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(newParent)}')/Components`;

    const body = {
      "@odata.id": `Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements('${encodeURIComponent(elementName)}')`,
      Weight: weight ?? 1,
    };

    await this.request<void>("POST", path, body);
  }

  // ── Element attribute methods ─────────────────────────────────────────────

  /**
   * List all element attribute definitions for a hierarchy.
   * GET /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/ElementAttributes
   */
  async listElementAttributes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: "Numeric" | "String" | "Alias" }>> {
    const enc = encodeURIComponent;
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/ElementAttributes`;
    const response = await this.request<{
      value: Array<{ Name: string; Type: string }>;
    }>("GET", path);
    return response.value.map((a) => ({
      name: a.Name,
      type: a.Type as "Numeric" | "String" | "Alias",
    }));
  }

  /**
   * Create an element attribute definition on a hierarchy.
   * POST /api/v1/Dimensions('{dim}')/Hierarchies('{hier}')/ElementAttributes
   *
   * Prefer TI prolog (DimensionElementInsert on }ElementAttributes_{dim})
   * for reproducible deployments. Use this REST-direct tool only for
   * ad-hoc / debugging scenarios.
   */
  async createElementAttribute(
    dimensionName: string,
    hierarchyName: string,
    attributeName: string,
    attributeType: "Numeric" | "String" | "Alias",
  ): Promise<void> {
    const enc = encodeURIComponent;
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/ElementAttributes`;
    await this.request<void>("POST", path, {
      Name: attributeName,
      Type: attributeType,
    });
  }

  // ── Cell write methods ────────────────────────────────────────────────────

  /**
   * Write multiple cells to a cube via the cellset PATCH path.
   *
   * TM1 11.8's Cube /tm1.Update action rejects every documented payload
   * variant ("Invalid CellDescriptor property" / "Unexpected entity reference
   * type" / "Expecting Object or EntityBind"). The cellset PATCH path is the
   * supported route in 11.8:
   *   1. POST /api/v1/ExecuteMDX with a slice MDX over the target cell
   *   2. PATCH /api/v1/Cellsets('{id}')/Cells(0) with {Value}
   *   3. DELETE /api/v1/Cellsets('{id}')
   *
   * Values can be numeric (for N-cubes) or strings (for string cells). Writes
   * to consolidated cells are rejected by TM1.
   *
   * Prefer TI processes for reproducible data loads. Use this REST-direct
   * tool only for ad-hoc / debugging writes.
   */
  async writeCells(
    cubeName: string,
    dimensions: string[],
    cells: Array<{ elements: string[]; value: number | string }>,
  ): Promise<void> {
    if (cells.length === 0) return;

    for (const c of cells) {
      if (c.elements.length !== dimensions.length) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Cell tuple length (${c.elements.length}) does not match dimension count (${dimensions.length}) for cube '${cubeName}'.`,
        });
      }

      const memberRefs = c.elements.map(
        (e, idx) => `[${dimensions[idx]}].[${dimensions[idx]}].[${e}]`,
      );
      const colMember = memberRefs[0];
      const rowTuple = memberRefs.slice(1).join(",");
      const mdx =
        memberRefs.length === 1
          ? `SELECT {${colMember}} ON COLUMNS FROM [${cubeName}]`
          : `SELECT {${colMember}} ON COLUMNS, {(${rowTuple})} ON ROWS FROM [${cubeName}]`;

      const cellset = await this.request<{ ID: string }>(
        "POST",
        "/api/v1/ExecuteMDX",
        { MDX: mdx },
      );
      const id = cellset.ID;

      try {
        await this.request<void>(
          "PATCH",
          `/api/v1/Cellsets('${encodeURIComponent(id)}')/Cells(0)`,
          { Value: c.value },
        );
      } finally {
        try {
          await this.request<void>(
            "DELETE",
            `/api/v1/Cellsets('${encodeURIComponent(id)}')`,
          );
        } catch {
          // cleanup best-effort
        }
      }
    }
  }

  // ── Operations methods ────────────────────────────────────────────────────

  /**
   * Get recent TM1 server message log entries.
   * GET /api/v1/MessageLogEntries?$orderby=TimeStamp desc&$top={top}
   */
  async getMessageLog(top = 100): Promise<MessageLogEntry[]> {
    const path = `/api/v1/MessageLogEntries?$orderby=TimeStamp desc&$top=${top}`;
    const response = await this.request<{
      value: Array<{ TimeStamp?: string; Timestamp?: string; Level?: string; Message?: string; Text?: string }>;
    }>("GET", path);
    return response.value.map((e) => ({
      timestamp: e.TimeStamp ?? e.Timestamp ?? "",
      level: (e.Level ?? "").toUpperCase(),
      message: e.Message ?? e.Text ?? "",
    }));
  }

  /**
   * List TI process error log files.
   * GET /api/v1/ErrorLogFiles
   * TM1 v11 OData exposes only `Filename` on this entity set (no LastUpdated/$select/$orderby
   * support). Sorting is filename-descending — filenames embed a yyyymmddhhmmss timestamp,
   * so lexical desc sort matches chronological newest-first.
   */
  async getErrorLogFiles(opts: { processName?: string; since?: string; top?: number } = {}): Promise<ErrorLogFile[]> {
    const top = opts.top ?? 50;
    const response = await this.request<{ value: Array<{ Filename?: string }> }>(
      "GET",
      "/api/v1/ErrorLogFiles",
    );
    let entries = response.value
      .map((e): ErrorLogFile => ({ filename: e.Filename ?? "" }))
      .filter((e) => e.filename);

    if (opts.processName) {
      const proc = opts.processName;
      // TM1 pattern: TM1ProcessError_<ts>_<id>_<proc>.log (proc at end before .log)
      // Legacy/manual pattern: <proc>_<ts>.log (proc at start)
      const suffix = `_${proc}.log`;
      const prefix = `${proc}_`;
      entries = entries.filter(
        (e) => e.filename.endsWith(suffix) || e.filename.startsWith(prefix) || e.filename === proc,
      );
    }
    if (opts.since) {
      const sinceCompact = opts.since.replace(/[^0-9]/g, "").slice(0, 14);
      if (sinceCompact.length >= 8) {
        entries = entries.filter((e) => {
          // TM1 pattern: TM1ProcessError_YYYYMMDDHHMMSS_... — timestamp after first underscore.
          // Fallback: any embedded YYYYMMDDHHMMSS-style group.
          const m = e.filename.match(/(?:TM1ProcessError_|_)(\d{14})/) ?? e.filename.match(/_(\d{8,14})\.log$/i);
          return m ? m[1] >= sinceCompact.slice(0, m[1].length) : true;
        });
      }
    }
    // Filename embeds yyyymmddhhmmss → lexical desc ≈ chronological newest-first.
    entries.sort((a, b) => (a.filename < b.filename ? 1 : a.filename > b.filename ? -1 : 0));
    return entries.slice(0, top);
  }

  /**
   * Fetch the raw text content of a single TI error log file.
   * GET /api/v1/ErrorLogFiles('<filename>')/Content
   */
  async getErrorLogContent(filename: string): Promise<string> {
    const path = `/api/v1/ErrorLogFiles('${encodeURIComponent(filename)}')/Content`;
    return await this.requestRaw("GET", path);
  }

  /**
   * List all active threads on the TM1 server.
   * GET /api/v1/Threads
   */
  async getThreads(): Promise<Thread[]> {
    const response = await this.request<{
      value: Array<{
        ID: number;
        Type: number;
        Name: string;
        Context?: string;
        State: string;
        Function: string;
        ObjectName: string;
        ElapsedTime?: string;
      }>;
    }>("GET", "/api/v1/Threads?$select=ID,Type,Name,Context,State,Function,ObjectName,ElapsedTime");
    const typeNames: Record<number, string> = { 1: "User", 2: "System", 4: "Admin", 8: "Chore", 16: "Extern" };
    return response.value.map((t) => ({
      id: t.ID,
      type: typeNames[t.Type] ?? `Type${t.Type}`,
      name: t.Name,
      state: t.State,
      function: t.Function,
      objectName: t.ObjectName,
      elapsedTime: t.ElapsedTime,
      context: t.Context,
    }));
  }

  /**
   * Cancel a running TM1 server thread.
   * POST /api/v1/Threads({id})/tm1.CancelOperation
   */
  async cancelThread(threadId: number): Promise<void> {
    await this.request<void>("POST", `/api/v1/Threads(${threadId})/tm1.CancelOperation`, {});
  }

  /**
   * List all active sessions on the TM1 server with associated user and threads.
   * GET /api/v1/Sessions?$expand=Threads,User($select=Name)
   */
  async getSessions(): Promise<Session[]> {
    const response = await this.request<{
      value: Array<{
        // TM1 v11.8 returns ID as number; v12 as string. Coerce below.
        ID: string | number;
        Active?: boolean;
        User?: { Name: string };
        Threads?: Array<{
          ID: number;
          Type: number | string;
          Name: string;
          State: string;
          Function: string;
          ObjectName: string;
          ObjectType?: string;
          LockType?: string;
          ElapsedTime?: string;
          WaitTime?: string;
          Info?: string;
        }>;
      }>;
    }>("GET", "/api/v1/Sessions?$expand=Threads,User($select=Name)");
    const typeNames: Record<number, string> = { 1: "User", 2: "System", 4: "Admin", 8: "Chore", 16: "Extern" };
    return response.value.map((s) => ({
      id: String(s.ID),
      user: s.User?.Name ?? "",
      ...(s.Active !== undefined ? { active: s.Active } : {}),
      threads: (s.Threads ?? []).map((t) => ({
        id: t.ID,
        type: typeof t.Type === "number" ? (typeNames[t.Type] ?? `Type${t.Type}`) : (t.Type ?? ""),
        name: t.Name ?? "",
        state: t.State ?? "",
        function: t.Function ?? "",
        objectName: t.ObjectName ?? "",
        ...(t.ObjectType !== undefined ? { objectType: t.ObjectType } : {}),
        ...(t.LockType !== undefined ? { lockType: t.LockType } : {}),
        ...(t.ElapsedTime !== undefined ? { elapsedTime: t.ElapsedTime } : {}),
        ...(t.WaitTime !== undefined ? { waitTime: t.WaitTime } : {}),
        ...(t.Info !== undefined ? { info: t.Info } : {}),
      })),
    }));
  }

  // ── Scheduling methods ────────────────────────────────────────────────────

  /**
   * Activate or deactivate a chore.
   * PATCH /api/v1/Chores('{name}') with { Active: bool }
   */
  async toggleChoreActive(choreName: string, active: boolean): Promise<void> {
    const path = `/api/v1/Chores('${encodeURIComponent(choreName)}')`;
    await this.request<void>("PATCH", path, { Active: active });
  }

  /**
   * Execute a chore immediately (bypass its schedule).
   * POST /api/v1/Chores('{name}')/tm1.Execute
   */
  async executeChore(choreName: string): Promise<void> {
    const path = `/api/v1/Chores('${encodeURIComponent(choreName)}')/tm1.Execute`;
    await this.request<void>("POST", path, {});
  }

  /**
   * Create a new chore.
   * POST /api/v1/Chores
   */
  async createChore(chore: ChoreCreate): Promise<void> {
    const body = {
      Name: chore.name,
      StartTime: chore.startTime,
      DSTSensitive: chore.dstSensitive,
      Active: chore.active,
      ExecutionMode: chore.executionMode,
      Frequency: `P${chore.frequency.days}DT${String(chore.frequency.hours).padStart(2, "0")}H${String(chore.frequency.minutes).padStart(2, "0")}M${String(chore.frequency.seconds).padStart(2, "0")}S`,
      Tasks: chore.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${encodeURIComponent(step.process)}')`,
        Parameters: step.parameters.map((p) => ({ Name: p.name, Value: p.value })),
      })),
    };
    await this.request<void>("POST", "/api/v1/Chores", body);
  }

  /**
   * Update an existing chore (partial update).
   * PATCH /api/v1/Chores('{name}')
   */
  async updateChore(choreName: string, updates: Partial<Pick<ChoreCreate, "startTime" | "active" | "dstSensitive" | "executionMode" | "frequency" | "steps">>): Promise<void> {
    const path = `/api/v1/Chores('${encodeURIComponent(choreName)}')`;
    const body: Record<string, unknown> = {};
    if (updates.startTime !== undefined) body.StartTime = updates.startTime;
    if (updates.active !== undefined) body.Active = updates.active;
    if (updates.dstSensitive !== undefined) body.DSTSensitive = updates.dstSensitive;
    if (updates.executionMode !== undefined) body.ExecutionMode = updates.executionMode;
    if (updates.frequency !== undefined) {
      const f = updates.frequency;
      body.Frequency = `P${f.days}DT${String(f.hours).padStart(2, "0")}H${String(f.minutes).padStart(2, "0")}M${String(f.seconds).padStart(2, "0")}S`;
    }
    if (updates.steps !== undefined) {
      body.Tasks = updates.steps.map((step, idx) => ({
        Step: idx,
        "Process@odata.bind": `Processes('${encodeURIComponent(step.process)}')`,
        Parameters: step.parameters.map((p) => ({ Name: p.name, Value: p.value })),
      }));
    }
    await this.request<void>("PATCH", path, body);
  }

  /**
   * Delete a chore.
   * DELETE /api/v1/Chores('{name}')
   */
  async deleteChore(choreName: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/Chores('${encodeURIComponent(choreName)}')`);
  }

  // ── Dimension management (new) ─────────────────────────────────────────────

  /**
   * Create a new dimension (with a default hierarchy of the same name).
   * POST /api/v1/Dimensions
   */
  async createDimension(name: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>("POST", "/api/v1/Dimensions", { Name: name });
    // TM1 11.8 does not auto-create the default hierarchy from the POST body.
    // Create it explicitly via a separate request.
    try {
      await this.request<void>(
        "POST",
        `/api/v1/Dimensions('${enc(name)}')/Hierarchies`,
        { Name: name },
      );
    } catch (err) {
      if (err instanceof TM1Error && err.httpStatus === 409) {
        // Hierarchy already exists (some TM1 versions create it automatically)
        return;
      }
      throw err;
    }
  }

  /**
   * Delete a dimension and all its hierarchies.
   * DELETE /api/v1/Dimensions('{name}')
   */
  async deleteDimension(name: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/Dimensions('${encodeURIComponent(name)}')`);
  }

  /**
   * Bulk upsert elements into a hierarchy using the OData batch endpoint.
   * Handles N, C, and S elements. Components for C-elements are set in a
   * separate pass to ensure all leaf elements exist first.
   *
   * POST /api/v1/$batch
   */
  async bulkUpsertElements(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<void> {
    const enc = encodeURIComponent;
    const baseUrl = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements`;

    // Pass 1: Create/upsert all elements without components (C-elements without children first)
    for (const el of elements) {
      const body: Record<string, unknown> = { Name: el.name, Type: el.type };
      try {
        await this.request<void>("POST", baseUrl, body);
      } catch (err) {
        if (err instanceof TM1Error && err.httpStatus === 409) {
          // Already exists – patch type if needed
          await this.request<void>("PATCH", `${baseUrl}('${enc(el.name)}')`, { Type: el.type });
        } else {
          throw err;
        }
      }
    }

    // Pass 2: Set components for consolidated elements
    const consolidated = elements.filter((el) => el.type === "Consolidated" && el.components && el.components.length > 0);
    for (const el of consolidated) {
      const path = `${baseUrl}('${enc(el.name)}')`;
      const body = {
        Components: el.components!.map((c) => ({
          "@odata.id": `Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Elements('${enc(c.name)}')`,
          Weight: c.weight,
        })),
      };
      await this.request<void>("PATCH", path, body);
    }
  }

  // ── Model building methods ─────────────────────────────────────────────────

  /**
   * Create a new cube with the given dimensions (in order).
   * POST /api/v1/Cubes
   */
  async createCube(name: string, dimensionNames: string[]): Promise<void> {
    await this.request<void>("POST", "/api/v1/Cubes", {
      Name: name,
      Dimensions: dimensionNames.map((d) => ({
        "@odata.id": `Dimensions('${encodeURIComponent(d)}')`,
      })),
    });
  }

  /**
   * Delete a cube.
   * DELETE /api/v1/Cubes('{name}')
   */
  async deleteCube(name: string): Promise<void> {
    await this.request<void>("DELETE", `/api/v1/Cubes('${encodeURIComponent(name)}')`);
  }

  /**
   * Get the rules text for a cube.
   * GET /api/v1/Cubes('{name}')/Rules
   */
  async getCubeRules(cubeName: string): Promise<CubeRules> {
    const path = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')/Rules`;
    try {
      // TM1 11.8 returns rules text in the "value" field (not "Text")
      const response = await this.request<{
        value?: string;
        Text?: string;
      }>("GET", path);
      const rulesText = response.value ?? response.Text ?? "";
      return {
        cubeName,
        rulesText,
        skipCheck: rulesText.toUpperCase().includes("SKIPCHECK"),
      };
    } catch (err) {
      if (err instanceof TM1Error && (err.httpStatus === 404 || err.httpStatus === 204)) {
        // No rules exist yet
        return { cubeName, rulesText: "", skipCheck: false };
      }
      throw err;
    }
  }

  /**
   * Bulk-fetch rules for every cube in a single round trip.
   * GET /api/v1/Cubes?$select=Name,Rules
   * Control cubes (Name starts with `}`) excluded unless includeControl=true.
   */
  async getAllCubeRules(includeControl = false): Promise<CubeRules[]> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const path = `/api/v1/Cubes?$select=Name,Rules${filter}`;
    const response = await this.request<{
      value: Array<{ Name: string; Rules?: string | null }>;
    }>("GET", path);
    return response.value.map((c) => {
      const rulesText = c.Rules ?? "";
      return {
        cubeName: c.Name,
        rulesText,
        skipCheck: rulesText.toUpperCase().includes("SKIPCHECK"),
      };
    });
  }

  /**
   * Create or replace the rules for a cube.
   * If rules exist: PATCH; if not: POST.
   * GET /api/v1/Cubes('{name}')/Rules
   */
  async updateCubeRules(cubeName: string, rulesText: string, _skipCheck = true): Promise<void> {
    // TM1 11.8: rules are set by PATCHing the Cube entity with {"Rules": "...text..."}
    // PATCH/POST on /Cubes('{name}')/Rules returns 400 "not supported"
    const cubePath = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')`;
    await this.request<void>("PATCH", cubePath, { Rules: rulesText });
  }

  /**
   * Validate cube rule syntax without applying. Returns empty array if valid,
   * otherwise array of {message, lineNumber?} errors.
   * POST /api/v1/Cubes('{name}')/tm1.CheckRules with { Rules: "..." }
   */
  async checkCubeRule(cubeName: string, ruleText: string): Promise<RuleSyntaxError[]> {
    const path = `/api/v1/Cubes('${encodeURIComponent(cubeName)}')/tm1.CheckRules`;
    const response = await this.request<{
      value?: Array<{ Message: string; LineNumber?: number }>;
    }>("POST", path, { Rules: ruleText });
    return (response.value ?? []).map((e) => ({
      message: e.Message,
      ...(e.LineNumber !== undefined ? { lineNumber: e.LineNumber } : {}),
    }));
  }

  // ── File operations ──────────────────────────────────────────────────────

  /**
   * List files in TM1 server's blob/file storage.
   * v12: GET /api/v1/Contents('Files')[/Contents('subdir')...]/Contents?$select=Name
   * v11: same with 'Blobs' instead of 'Files'.
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async listFiles(path?: string): Promise<string[]> {
    const segments = path ? path.split("/").filter(Boolean) : [];
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${encodeURIComponent(root)}')`;
      for (const seg of segments) {
        url += `/Contents('${encodeURIComponent(seg)}')`;
      }
      url += "/Contents?$select=Name";
      return url;
    };
    try {
      const r = await this.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Files"));
      return r.value.map((f) => f.Name);
    } catch {
      const r = await this.request<{ value: Array<{ Name: string }> }>("GET", buildUrl("Blobs"));
      return r.value.map((f) => f.Name);
    }
  }

  /**
   * Get the content of a file from TM1 server's blob/file storage.
   * Returns raw text (CSV/TXT/etc).
   * Tries v12 'Files' first, falls back to v11 'Blobs'.
   */
  async getFileContent(fileName: string): Promise<string> {
    const parts = fileName.split("/").filter(Boolean);
    const buildUrl = (root: string): string => {
      let url = `/api/v1/Contents('${encodeURIComponent(root)}')`;
      for (const p of parts) {
        url += `/Contents('${encodeURIComponent(p)}')`;
      }
      url += "/Content";
      return url;
    };
    try {
      return await this.requestRaw("GET", buildUrl("Files"));
    } catch {
      return await this.requestRaw("GET", buildUrl("Blobs"));
    }
  }

  // ── Server info ──────────────────────────────────────────────────────────

  /**
   * Fetch TM1 server configuration. Merges /Configuration and /ActiveConfiguration.
   */
  async getServerInfo(): Promise<ServerInfo> {
    const cfg = await this.request<Record<string, unknown>>("GET", "/api/v1/Configuration");
    let active: Record<string, unknown> = {};
    try {
      active = await this.request<Record<string, unknown>>("GET", "/api/v1/ActiveConfiguration");
    } catch {
      // Some TM1 versions don't expose ActiveConfiguration — ignore.
    }
    const merged: Record<string, unknown> = { ...cfg, ...active };
    delete merged["@odata.context"];
    return {
      serverName: String(merged.ServerName ?? ""),
      productVersion: String(merged.ProductVersion ?? ""),
      productEdition: merged.ProductEdition !== undefined ? String(merged.ProductEdition) : undefined,
      adminHost: merged.AdminHost !== undefined ? String(merged.AdminHost) : undefined,
      dataDirectory: merged.DataBaseDirectory !== undefined ? String(merged.DataBaseDirectory) : undefined,
      timeZoneId: merged.TimeZoneID !== undefined ? String(merged.TimeZoneID) : undefined,
      integratedSecurityMode: merged.IntegratedSecurityMode !== undefined ? String(merged.IntegratedSecurityMode) : undefined,
      extra: merged,
    };
  }

  // ── TI development (compile) ─────────────────────────────────────────────

  /**
   * Compile a TI process to check its syntax without executing it.
   * POST /api/v1/Processes('{name}')/tm1.Compile
   */
  async compileProcess(processName: string): Promise<CompileResult> {
    const path = `/api/v1/Processes('${encodeURIComponent(processName)}')/tm1.Compile`;
    try {
      const response = await this.request<{
        value?: Array<{ LineNumber?: number; Procedure?: string; Message?: string }>;
      }>("POST", path, {});
      const errors = (response?.value ?? []).map((e) => ({
        lineNumber: e.LineNumber,
        procedure: e.Procedure,
        message: e.Message ?? "",
      }));
      return { success: errors.length === 0, errors };
    } catch (err) {
      if (err instanceof TM1Error) {
        return {
          success: false,
          errors: [{ message: err.details ?? err.message }],
        };
      }
      throw err;
    }
  }

  /**
   * Validate a TI process WITHOUT saving it on the server.
   * POST /api/v1/CompileProcess body { Process: <full process body> }.
   * Mirrors tm1py's compile_process_with_body. Returns CompileResult identical
   * to compileProcess() for callers that already handle that shape.
   */
  async checkProcessCode(input: ProcessCheckInput): Promise<CompileResult> {
    const path = "/api/v1/CompileProcess";

    const processBody: Record<string, unknown> = {
      Name: input.name ?? "_compile_check",
      PrologProcedure: input.prolog ?? "",
      MetadataProcedure: input.metadata ?? "",
      DataProcedure: input.data ?? "",
      EpilogProcedure: input.epilog ?? "",
    };

    if (input.parameters) {
      processBody.Parameters = input.parameters.map((p) => ({
        Name: p.name,
        Type: p.type === "Numeric" ? 1 : 2,
        Value: p.defaultValue,
        ...(p.prompt ? { Prompt: p.prompt } : {}),
      }));
    }

    if (input.variables) {
      processBody.Variables = input.variables.map((v) => ({
        Name: v.name,
        Type: v.type,
        Position: v.position,
        StartByte: v.startByte ?? 0,
        EndByte: v.endByte ?? 0,
      }));
    }

    if (input.dataSource) {
      const ds = input.dataSource;
      const dsBody: Record<string, unknown> = { Type: ds.type };
      if (ds.dataSourceNameForServer !== undefined) dsBody.dataSourceNameForServer = ds.dataSourceNameForServer;
      if (ds.dataSourceNameForClient !== undefined) dsBody.dataSourceNameForClient = ds.dataSourceNameForClient;
      if (ds.asciiDelimiterType !== undefined) dsBody.asciiDelimiterType = ds.asciiDelimiterType;
      if (ds.asciiDelimiterChar !== undefined) dsBody.asciiDelimiterChar = ds.asciiDelimiterChar;
      if (ds.asciiQuoteCharacter !== undefined) dsBody.asciiQuoteCharacter = ds.asciiQuoteCharacter;
      if (ds.asciiHeaderRecords !== undefined) dsBody.asciiHeaderRecords = ds.asciiHeaderRecords;
      if (ds.asciiDecimalSeparator !== undefined) dsBody.asciiDecimalSeparator = ds.asciiDecimalSeparator;
      if (ds.asciiThousandSeparator !== undefined) dsBody.asciiThousandSeparator = ds.asciiThousandSeparator;
      // usesUnicode: same v11 quirk as updateProcessDataSource — drop on TM1 11.x.
      if (ds.usesUnicode !== undefined && !this.config.tm1Version.startsWith("11")) {
        dsBody.usesUnicode = ds.usesUnicode;
      }
      if (ds.userName !== undefined) dsBody.userName = ds.userName;
      if (ds.password !== undefined) dsBody.password = ds.password;
      if (ds.oDBCConnection !== undefined) dsBody.oDBCConnection = ds.oDBCConnection;
      if (ds.query !== undefined) dsBody.query = ds.query;
      if (ds.view !== undefined) dsBody.view = ds.view;
      if (ds.subset !== undefined) dsBody.subset = ds.subset;
      processBody.DataSource = dsBody;
    } else {
      processBody.DataSource = { Type: "None" };
    }

    try {
      const response = await this.request<{
        value?: Array<{ LineNumber?: number; Procedure?: string; Message?: string }>;
      }>("POST", path, { Process: processBody });
      const errors = (response?.value ?? []).map((e) => ({
        lineNumber: e.LineNumber,
        procedure: e.Procedure,
        message: e.Message ?? "",
      }));
      return { success: errors.length === 0, errors };
    } catch (err) {
      if (err instanceof TM1Error) {
        return {
          success: false,
          errors: [{ message: err.details ?? err.message }],
        };
      }
      throw err;
    }
  }

  // ── Hierarchy management ─────────────────────────────────────────────────

  /**
   * Create a new hierarchy inside an existing dimension.
   * POST /api/v1/Dimensions('{d}')/Hierarchies
   */
  async createHierarchy(dimensionName: string, hierarchyName: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>(
      "POST",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies`,
      { Name: hierarchyName },
    );
  }

  /**
   * Delete a hierarchy from a dimension.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')
   */
  async deleteHierarchy(dimensionName: string, hierarchyName: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>(
      "DELETE",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')`,
    );
  }

  // ── View management ──────────────────────────────────────────────────────

  /**
   * List all views defined on a cube (public + private).
   * GET /api/v1/Cubes('{c}')/Views + /PrivateViews
   */
  async listViews(cubeName: string): Promise<CubeView[]> {
    const enc = encodeURIComponent;
    const result: CubeView[] = [];
    try {
      const pub = await this.request<{ value: Array<{ Name: string; MDX?: string }> }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')/Views?$select=Name,MDX`,
      );
      result.push(...pub.value.map((v) => ({ name: v.Name, mdx: v.MDX, private: false })));
    } catch {
      // no public views
    }
    try {
      const priv = await this.request<{ value: Array<{ Name: string; MDX?: string }> }>(
        "GET",
        `/api/v1/Cubes('${enc(cubeName)}')/PrivateViews?$select=Name,MDX`,
      );
      result.push(...priv.value.map((v) => ({ name: v.Name, mdx: v.MDX, private: true })));
    } catch {
      // no private views
    }
    return result;
  }

  /**
   * Create a public MDX-based view on a cube.
   * POST /api/v1/Cubes('{c}')/Views with @odata.type = #ibm.tm1.api.v1.MDXView
   */
  async createMdxView(cubeName: string, viewName: string, mdx: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/Views`,
      {
        "@odata.type": "#ibm.tm1.api.v1.MDXView",
        Name: viewName,
        MDX: mdx,
      },
    );
  }

  /**
   * Delete a public view from a cube.
   * DELETE /api/v1/Cubes('{c}')/Views('{v}')
   */
  async deleteView(cubeName: string, viewName: string): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>(
      "DELETE",
      `/api/v1/Cubes('${enc(cubeName)}')/Views('${enc(viewName)}')`,
    );
  }

  // ── Subset management ────────────────────────────────────────────────────

  /**
   * List public + private subsets of a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets
   */
  async listSubsets(dimensionName: string, hierarchyName: string): Promise<Subset[]> {
    const enc = encodeURIComponent;
    const result: Subset[] = [];
    const fetchScope = async (segment: "Subsets" | "PrivateSubsets", isPrivate: boolean) => {
      try {
        const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/${segment}?$select=Name,Expression,Alias`;
        const response = await this.request<{
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
  async getSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    isPrivate = false,
  ): Promise<Subset> {
    const enc = encodeURIComponent;
    const segment = isPrivate ? "PrivateSubsets" : "Subsets";
    const path = `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/${segment}('${enc(subsetName)}')?$expand=Elements($select=Name)&$select=Name,Expression,Alias`;
    const response = await this.request<{
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
   * Create a public subset. Either MDX-based (expression) or static (elements).
   * POST /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets
   */
  async createSubset(
    dimensionName: string,
    hierarchyName: string,
    subset: SubsetCreate,
  ): Promise<void> {
    const enc = encodeURIComponent;
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
    await this.request<void>("POST", path, body);
  }

  /**
   * Update an existing public subset.
   * PATCH /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')
   */
  async updateSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    update: { expression?: string; elements?: string[]; alias?: string },
  ): Promise<void> {
    const enc = encodeURIComponent;
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
    await this.request<void>("PATCH", path, body);
  }

  /**
   * Delete a public subset.
   * DELETE /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets('{s}')
   */
  async deleteSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
  ): Promise<void> {
    const enc = encodeURIComponent;
    await this.request<void>(
      "DELETE",
      `/api/v1/Dimensions('${enc(dimensionName)}')/Hierarchies('${enc(hierarchyName)}')/Subsets('${enc(subsetName)}')`,
    );
  }

  // ── Element attribute values ─────────────────────────────────────────────

  /**
   * Read all attribute values for one element via MDX on }ElementAttributes_{Dim}.
   */
  async getElementAttributeValues(
    dimensionName: string,
    elementName: string,
  ): Promise<ElementAttributeValue[]> {
    const ctrlCube = `}ElementAttributes_${dimensionName}`;
    const mdx =
      `SELECT {[}ElementAttributes_${dimensionName}].MEMBERS} ON COLUMNS ` +
      `FROM [${ctrlCube}] ` +
      `WHERE ([${dimensionName}].[${elementName}])`;
    const result = await this.executeMdx(mdx);
    const out: ElementAttributeValue[] = [];
    const tuples = result.axes[0]?.tuples ?? [];
    for (let i = 0; i < tuples.length; i++) {
      const attrName = tuples[i].members[0]?.name ?? "";
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
   * }ElementAttributes_{Dim} control cube.
   *
   * Prefer TI processes (CellPutS / AttrPutS) for reproducible deployments.
   * Use this REST-direct tool only for ad-hoc / debugging scenarios.
   */
  async updateElementAttributeValue(
    dimensionName: string,
    elementName: string,
    attributeName: string,
    value: number | string,
  ): Promise<void> {
    const ctrlCube = `}ElementAttributes_${dimensionName}`;
    await this.writeCells(
      ctrlCube,
      [dimensionName, `}ElementAttributes_${dimensionName}`],
      [{ elements: [elementName, attributeName], value }],
    );
  }

  // ── Cube clear ───────────────────────────────────────────────────────────

  /**
   * Clear a subset of cells from a cube by specifying a list of element names
   * per dimension. Empty array for a dimension = all elements (wildcard).
   *
   * - TM1 12.x: native POST /api/v1/Cubes('{c}')/tm1.Clear
   * - TM1 11.x: tm1.Clear is not implemented. Falls back to:
   *     - Full-cube clear (all dimensions wildcarded): ephemeral TI with CubeClearData()
   *     - Partial clear: throws TM1Error with guidance to use a TI process
   */
  async clearCube(
    cubeName: string,
    dimensions: string[],
    tuples: string[][],
  ): Promise<void> {
    if (this.config.tm1Version.startsWith("11")) {
      const isFullClear = dimensions.every((_, i) => (tuples[i] ?? []).length === 0);
      if (!isFullClear) {
        throw new TM1Error({
          code: TM1ErrorCode.UNSUPPORTED_OPERATION,
          message: `Partial clearCube is not supported on TM1 ${this.config.tm1Version} (tm1.Clear endpoint unavailable). Implement a TI process with bedrock '}bedrock.cube.data.clear' or custom CellPutN loop and call via tm1_execute_process.`,
          endpoint: `/api/v1/Cubes('${cubeName}')/tm1.Clear`,
        });
      }
      await this.clearCubeViaTI(cubeName);
      return;
    }

    const enc = encodeURIComponent;
    const body = {
      Tuples: dimensions.map((dim, idx) => ({
        "Hierarchy@odata.bind": `Dimensions('${enc(dim)}')/Hierarchies('${enc(dim)}')`,
        "Members@odata.bind": (tuples[idx] ?? []).map(
          (el) =>
            `Dimensions('${enc(dim)}')/Hierarchies('${enc(dim)}')/Members('${enc(el)}')`,
        ),
      })),
    };
    await this.request<void>(
      "POST",
      `/api/v1/Cubes('${enc(cubeName)}')/tm1.Clear`,
      body,
    );
  }

  /**
   * 11.x fallback: deploy ephemeral TI with CubeClearData(), execute, delete.
   */
  private async clearCubeViaTI(cubeName: string): Promise<void> {
    const enc = encodeURIComponent;
    const procName = `}TempClear_${cubeName.replace(/[^A-Za-z0-9_]/g, "_")}_${Date.now()}`;
    const safeCube = cubeName.replace(/'/g, "''");
    const prologCode = `CubeClearData('${safeCube}');`;

    await this.request<void>("POST", "/api/v1/Processes", {
      Name: procName,
      HasSecurityAccess: false,
      PrologProcedure: prologCode,
      MetadataProcedure: "",
      DataProcedure: "",
      EpilogProcedure: "",
      DataSource: { Type: "None" },
    });

    try {
      await this.request<void>(
        "POST",
        `/api/v1/Processes('${enc(procName)}')/tm1.ExecuteWithReturn`,
        {},
      );
    } finally {
      try {
        await this.request<void>("DELETE", `/api/v1/Processes('${enc(procName)}')`);
      } catch (cleanupErr) {
        this.logger.warn(
          { proc: procName, err: String(cleanupErr) },
          "Failed to delete ephemeral clearCube TI process — manual cleanup needed",
        );
      }
    }
  }

  // ── Cube unload ──────────────────────────────────────────────────────────

  /**
   * Unload a cube from memory. Forces TM1 to discard the in-memory fed-cell
   * index and reload from disk on next access. Required for feeder corrections
   * to take effect — the fed-cell index is cumulative, so changes to existing
   * feeders only become visible after an unload.
   *
   * POST /api/v1/Cubes('{cube}')/tm1.Unload
   */
  async unloadCube(cubeName: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/v1/Cubes('${encodeURIComponent(cubeName)}')/tm1.Unload`,
    );
  }

  // ── Transaction log ──────────────────────────────────────────────────────

  /**
   * Fetch recent TM1 transaction log entries (cell writes).
   * GET /api/v1/TransactionLogEntries
   */
  async getTransactionLog(opts: {
    top?: number;
    cubeName?: string;
    user?: string;
    since?: string; // ISO timestamp
  }): Promise<TransactionLogEntry[]> {
    const filters: string[] = [];
    if (opts.cubeName) filters.push(`Cube eq '${opts.cubeName.replace(/'/g, "''")}'`);
    if (opts.user) filters.push(`User eq '${opts.user.replace(/'/g, "''")}'`);
    if (opts.since) filters.push(`TimeStamp ge ${opts.since}`);
    const top = opts.top ?? 100;
    const qs: string[] = [`$top=${top}`, `$orderby=TimeStamp desc`];
    if (filters.length > 0) qs.push(`$filter=${encodeURIComponent(filters.join(" and "))}`);
    const path = `/api/v1/TransactionLogEntries?${qs.join("&")}`;
    const response = await this.request<{
      value: Array<{
        TimeStamp?: string;
        User?: string;
        Cube?: string;
        Tuple?: string[];
        OldValue?: CellValue;
        NewValue?: CellValue;
      }>;
    }>("GET", path);
    return response.value.map((e) => ({
      timestamp: e.TimeStamp ?? "",
      user: e.User ?? "",
      cubeName: e.Cube ?? "",
      elements: e.Tuple ?? [],
      oldValue: e.OldValue ?? null,
      newValue: e.NewValue ?? null,
    }));
  }

  // --- Security: Users (Clients) ---
  // TM1 11.8 uses /api/v1/Users (not /Clients). Tool names retain "client"
  // for backward-compatibility with the MCP surface.

  async listClients(): Promise<Client[]> {
    const res = await this.request<{ value: Client[] }>(
      "GET",
      "/api/v1/Users?$select=Name,FriendlyName,Type,Enabled&$expand=Groups",
    );
    return res.value;
  }

  async getClient(name: string): Promise<Client> {
    return this.request<Client>(
      "GET",
      `/api/v1/Users('${encodeURIComponent(name)}')?$select=Name,FriendlyName,Type,Enabled&$expand=Groups`,
    );
  }

  async createClient(payload: ClientCreate): Promise<void> {
    const body: Record<string, unknown> = {
      Name: payload.name,
    };
    if (payload.password !== undefined) body.Password = payload.password;
    if (payload.friendlyName !== undefined) body.FriendlyName = payload.friendlyName;
    if (payload.groups !== undefined) {
      body["Groups@odata.bind"] = payload.groups.map(
        (g) => `Groups('${encodeURIComponent(g)}')`,
      );
    }
    await this.request<void>("POST", "/api/v1/Users", body);
  }

  async updateClient(name: string, payload: ClientUpdate): Promise<void> {
    const body: Record<string, unknown> = {};
    if (payload.password !== undefined) body.Password = payload.password;
    if (payload.friendlyName !== undefined) body.FriendlyName = payload.friendlyName;
    if (payload.enabled !== undefined) body.Enabled = payload.enabled;
    await this.request<void>(
      "PATCH",
      `/api/v1/Users('${encodeURIComponent(name)}')`,
      body,
    );
  }

  async deleteClient(name: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/v1/Users('${encodeURIComponent(name)}')`,
    );
  }

  // --- Security: Groups ---

  async listGroups(): Promise<Group[]> {
    // TM1 REST: Groups expose their members under the `Users` navigation
    // property (not `Clients`, despite TM1's user-facing "Client" terminology).
    // Verified on TM1 v11.8 — using `$expand=Clients` returns HTTP 400.
    const res = await this.request<{ value: Array<{ Name: string; Users?: Array<{ Name: string }> }> }>(
      "GET",
      "/api/v1/Groups?$expand=Users($select=Name)",
    );
    return res.value.map((g) => ({
      Name: g.Name,
      Clients: g.Users ?? [],
    }));
  }

  async assignClientGroup(clientName: string, groupName: string): Promise<void> {
    // tm1py pattern: PATCH /Users('x') with Name + Groups@odata.bind
    await this.request<void>(
      "PATCH",
      `/api/v1/Users('${encodeURIComponent(clientName)}')`,
      {
        Name: clientName,
        "Groups@odata.bind": [`Groups('${encodeURIComponent(groupName)}')`],
      },
    );
  }

  async removeClientGroup(clientName: string, groupName: string): Promise<void> {
    // tm1py pattern: DELETE /Users('x')/Groups?$id=Groups('y')
    await this.request<void>(
      "DELETE",
      `/api/v1/Users('${encodeURIComponent(clientName)}')/Groups?$id=Groups('${encodeURIComponent(groupName)}')`,
    );
  }
}
