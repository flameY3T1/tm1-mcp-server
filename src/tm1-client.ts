import { TM1Error, TM1ErrorCode } from "./types.js";
import type { Cube, Dimension, Hierarchy, HierarchyElement, Process, ProcessParameter, ProcessVariable, ProcessResult, ProcessCode, DataSource, Chore, CellValue, MdxResult, MdxAxis, ViewResult, ViewDefinition, ElementCreate, ElementUpdate, Thread, MessageLogEntry, CubeRules, ChoreCreate, ServerInfo, CompileResult, ProcessCheckInput, CubeView, TransactionLogEntry, Subset, SubsetCreate, ElementAttributeValue, Client, ClientCreate, ClientUpdate, Group, Session, RuleSyntaxError, ErrorLogFile } from "./types.js";
import type { TM1Config } from "./config.js";
import type { SessionManager } from "./session-manager.js";
import type pino from "pino";
import { TM1HttpClient } from "./tm1-client/http.js";
import { CubeService } from "./tm1-client/services/cube-service.js";
import { DimensionService } from "./tm1-client/services/dimension-service.js";
import { HierarchyService } from "./tm1-client/services/hierarchy-service.js";
import { ElementService } from "./tm1-client/services/element-service.js";
import { CellService } from "./tm1-client/services/cell-service.js";
import { ViewService } from "./tm1-client/services/view-service.js";
import { SubsetService } from "./tm1-client/services/subset-service.js";

/**
 * TM1 facade. Domain-specific OData calls live in service classes
 * (`this.cubes`, etc.) — see docs/ARCHITECTURE.md. Flat methods
 * (`getCubes`, ...) remain as deprecated wrappers during the migration
 * period and will be removed in 2.0.
 */
export class TM1Client extends TM1HttpClient {
  private connected = false;

  // Domain services. Add new ones here as the god-class split progresses.
  // Init order matters when services depend on each other — `cells` is
  // created before `elements` because the latter holds a CellService ref.
  readonly cubes: CubeService;
  readonly dimensions: DimensionService;
  readonly hierarchies: HierarchyService;
  readonly cells: CellService;
  readonly views: ViewService;
  readonly subsets: SubsetService;
  readonly elements: ElementService;

  constructor(config: TM1Config, sessionManager: SessionManager, logger: pino.Logger) {
    super(config, sessionManager, logger);
    this.cubes = new CubeService(this);
    this.dimensions = new DimensionService(this);
    this.hierarchies = new HierarchyService(this);
    this.cells = new CellService(this);
    this.views = new ViewService(this);
    this.subsets = new SubsetService(this);
    this.elements = new ElementService(this, this.cells);
  }

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
  /** @deprecated Use `client.cubes.list(opts)` instead. Removed in 2.0. */
  async getCubes(opts: { includeRules?: boolean } = {}): Promise<Cube[]> {
    return this.cubes.list(opts);
  }

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
  /** @deprecated Use `client.dimensions.list(opts)` instead. Removed in 2.0. */
  async getDimensions(opts?: { includeElementCount?: boolean }): Promise<Dimension[]> {
    return this.dimensions.list(opts);
  }

  /**
   * Get a specific hierarchy with its elements, including parent/child relationships.
   * GET /api/v1/Dimensions('{dimensionName}')/Hierarchies('{hierarchyName}')?$expand=Elements(...)
   *
   * Optional opts apply server-side filters (level, levelMax, elementType) and topN
   * truncation. Filtered-out elements are removed from parents/children arrays of
   * remaining elements to avoid dangling references.
   */
  /** @deprecated Use `client.hierarchies.get(dim, hier, opts)` instead. Removed in 2.0. */
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
    return this.hierarchies.get(dimensionName, hierarchyName, opts);
  }

  /**
   * Resolve descendants of a consolidation element via client-side BFS over
   * the full hierarchy. Returns a flat list with depth from the start element.
   * Reuses getHierarchy() — REST traffic identical, but the LLM-facing payload
   * is a focused subtree, not the whole dimension.
   */
  /** @deprecated Use `client.hierarchies.getDescendants(...)` instead. Removed in 2.0. */
  async getDescendants(
    dimensionName: string,
    hierarchyName: string,
    element: string,
    opts?: { depth?: number; leavesOnly?: boolean },
  ): Promise<{
    element: string;
    descendants: Array<{ name: string; type: HierarchyElement["type"]; level: number; depth: number }>;
  }> {
    return this.hierarchies.getDescendants(dimensionName, hierarchyName, element, opts);
  }

  /**
   * Resolve ancestors of an element via parent-walk. Handles multi-parent
   * hierarchies — returns the unique flat ancestor set AND every distinct
   * root-to-element path so consumers can see consolidation alternatives.
   */
  /** @deprecated Use `client.hierarchies.getAncestors(...)` instead. Removed in 2.0. */
  async getAncestors(
    dimensionName: string,
    hierarchyName: string,
    element: string,
  ): Promise<{
    element: string;
    ancestors: Array<{ name: string; level: number }>;
    paths: string[][];
  }> {
    return this.hierarchies.getAncestors(dimensionName, hierarchyName, element);
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
  /** @deprecated Use `client.cells.getValue(cubeName, elements)` instead. Removed in 2.0. */
  async getCellValue(cubeName: string, elements: string[]): Promise<CellValue> {
    return this.cells.getValue(cubeName, elements);
  }

  /**
   * Return ordered dimension-name list of a cube.
   * GET /api/v1/Cubes('{name}')?$expand=Dimensions($select=Name)
   */
  /** @deprecated Use `client.cubes.getDimensionNames(cubeName)` instead. Removed in 2.0. */
  async getCubeDimensionNames(cubeName: string): Promise<string[]> {
    return this.cubes.getDimensionNames(cubeName);
  }

  /**
   * Execute an MDX query and return structured results with cells and axes.
   * Supports pagination via optional top/skip parameters on the Cells expand.
   */
  /** @deprecated Use `client.cells.executeMdx(mdx, top, skip, opts)` instead. Removed in 2.0. */
  async executeMdx(
    mdx: string,
    top?: number,
    skip?: number,
    opts?: { timeoutMs?: number },
  ): Promise<MdxResult> {
    return this.cells.executeMdx(mdx, top, skip, opts);
  }

  /**
   * Execute a named view and return structured results.
   * POST /api/v1/Cubes('{cubeName}')/Views('{viewName}')/tm1.Execute
   */
  /** @deprecated Use `client.views.getView(cubeName, viewName)` instead. Removed in 2.0. */
  async getView(cubeName: string, viewName: string): Promise<ViewResult> {
    return this.views.getView(cubeName, viewName);
  }

  /**
   * Return the structural definition of a view (MDX expression OR native axes)
   * WITHOUT executing it. Auto-falls back from public to private when isPrivate
   * is undefined.
   * GET /api/v1/Cubes('X')/Views('Y') with tm1.NativeView/* expands.
   */
  /** @deprecated Use `client.views.getDefinition(cubeName, viewName, isPrivate)` instead. Removed in 2.0. */
  async getViewDefinition(
    cubeName: string,
    viewName: string,
    isPrivate?: boolean,
  ): Promise<ViewDefinition> {
    return this.views.getDefinition(cubeName, viewName, isPrivate);
  }

  // ── Process execution methods ──────────────────────────────────────────────

  /**
   * Execute a TI process with optional parameters.
   * POST /api/v1/Processes('{processName}')/tm1.Execute
   */
  async executeProcess(
    processName: string,
    params?: Record<string, string | number>,
    opts?: { timeoutMs?: number },
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
      await this.request<void>("POST", path, body, opts);
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
  /** @deprecated Use `client.elements.create(...)` instead. Removed in 2.0. */
  async createElement(
    dimensionName: string,
    hierarchyName: string,
    element: ElementCreate,
  ): Promise<void> {
    return this.elements.create(dimensionName, hierarchyName, element);
  }

  /** @deprecated Use `client.elements.update(...)` instead. Removed in 2.0. */
  async updateElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    update: ElementUpdate,
  ): Promise<void> {
    return this.elements.update(dimensionName, hierarchyName, elementName, update);
  }

  /** @deprecated Use `client.elements.delete(...)` instead. Removed in 2.0. */
  async deleteElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
  ): Promise<void> {
    return this.elements.delete(dimensionName, hierarchyName, elementName);
  }

  /** @deprecated Use `client.elements.move(...)` instead. Removed in 2.0. */
  async moveElement(
    dimensionName: string,
    hierarchyName: string,
    elementName: string,
    newParent: string,
    weight?: number,
  ): Promise<void> {
    return this.elements.move(dimensionName, hierarchyName, elementName, newParent, weight);
  }

  // ── Element attribute methods ─────────────────────────────────────────────

  /** @deprecated Use `client.elements.listAttributes(...)` instead. Removed in 2.0. */
  async listElementAttributes(
    dimensionName: string,
    hierarchyName: string,
  ): Promise<Array<{ name: string; type: "Numeric" | "String" | "Alias" }>> {
    return this.elements.listAttributes(dimensionName, hierarchyName);
  }

  /** @deprecated Use `client.elements.createAttribute(...)` instead. Removed in 2.0. */
  async createElementAttribute(
    dimensionName: string,
    hierarchyName: string,
    attributeName: string,
    attributeType: "Numeric" | "String" | "Alias",
  ): Promise<void> {
    return this.elements.createAttribute(dimensionName, hierarchyName, attributeName, attributeType);
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
  /** @deprecated Use `client.cells.writeCells(cubeName, dimensions, cells)` instead. Removed in 2.0. */
  async writeCells(
    cubeName: string,
    dimensions: string[],
    cells: Array<{ elements: string[]; value: number | string }>,
  ): Promise<void> {
    return this.cells.writeCells(cubeName, dimensions, cells);
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
  async executeChore(choreName: string, opts?: { timeoutMs?: number }): Promise<void> {
    const path = `/api/v1/Chores('${encodeURIComponent(choreName)}')/tm1.Execute`;
    await this.request<void>("POST", path, {}, opts);
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
  /** @deprecated Use `client.dimensions.create(name)` instead. Removed in 2.0. */
  async createDimension(name: string): Promise<void> {
    return this.dimensions.create(name);
  }

  /** @deprecated Use `client.dimensions.delete(name)` instead. Removed in 2.0. */
  async deleteDimension(name: string): Promise<void> {
    return this.dimensions.delete(name);
  }

  /** @deprecated Use `client.elements.bulkUpsert(...)` instead. Removed in 2.0. */
  async bulkUpsertElements(
    dimensionName: string,
    hierarchyName: string,
    elements: ElementCreate[],
  ): Promise<void> {
    return this.elements.bulkUpsert(dimensionName, hierarchyName, elements);
  }

  // ── Model building methods ─────────────────────────────────────────────────

  /**
   * Create a new cube with the given dimensions (in order).
   * POST /api/v1/Cubes
   */
  /** @deprecated Use `client.cubes.create(name, dimensionNames)` instead. Removed in 2.0. */
  async createCube(name: string, dimensionNames: string[]): Promise<void> {
    return this.cubes.create(name, dimensionNames);
  }

  /** @deprecated Use `client.cubes.delete(name)` instead. Removed in 2.0. */
  async deleteCube(name: string): Promise<void> {
    return this.cubes.delete(name);
  }

  /** @deprecated Use `client.cubes.getRules(cubeName)` instead. Removed in 2.0. */
  async getCubeRules(cubeName: string): Promise<CubeRules> {
    return this.cubes.getRules(cubeName);
  }

  /** @deprecated Use `client.cubes.getAllRules(includeControl)` instead. Removed in 2.0. */
  async getAllCubeRules(includeControl = false): Promise<CubeRules[]> {
    return this.cubes.getAllRules(includeControl);
  }

  /** @deprecated Use `client.cubes.updateRules(cubeName, rulesText)` instead. Removed in 2.0. */
  async updateCubeRules(cubeName: string, rulesText: string, _skipCheck = true): Promise<void> {
    return this.cubes.updateRules(cubeName, rulesText, _skipCheck);
  }

  /** @deprecated Use `client.cubes.checkRule(cubeName, ruleText)` instead. Removed in 2.0. */
  async checkCubeRule(cubeName: string, ruleText: string): Promise<RuleSyntaxError[]> {
    return this.cubes.checkRule(cubeName, ruleText);
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
  /** @deprecated Use `client.hierarchies.create(...)` instead. Removed in 2.0. */
  async createHierarchy(dimensionName: string, hierarchyName: string): Promise<void> {
    return this.hierarchies.create(dimensionName, hierarchyName);
  }

  /** @deprecated Use `client.hierarchies.delete(...)` instead. Removed in 2.0. */
  async deleteHierarchy(dimensionName: string, hierarchyName: string): Promise<void> {
    return this.hierarchies.delete(dimensionName, hierarchyName);
  }

  // ── View management ──────────────────────────────────────────────────────

  /**
   * List all views defined on a cube (public + private).
   * GET /api/v1/Cubes('{c}')/Views + /PrivateViews
   */
  /** @deprecated Use `client.views.list(cubeName)` instead. Removed in 2.0. */
  async listViews(cubeName: string): Promise<CubeView[]> {
    return this.views.list(cubeName);
  }

  /** @deprecated Use `client.views.createMdx(cubeName, viewName, mdx)` instead. Removed in 2.0. */
  async createMdxView(cubeName: string, viewName: string, mdx: string): Promise<void> {
    return this.views.createMdx(cubeName, viewName, mdx);
  }

  /** @deprecated Use `client.views.delete(cubeName, viewName)` instead. Removed in 2.0. */
  async deleteView(cubeName: string, viewName: string): Promise<void> {
    return this.views.delete(cubeName, viewName);
  }

  // ── Subset management ────────────────────────────────────────────────────

  /**
   * List public + private subsets of a hierarchy.
   * GET /api/v1/Dimensions('{d}')/Hierarchies('{h}')/Subsets|PrivateSubsets
   */
  /** @deprecated Use `client.subsets.list(dim, hier)` instead. Removed in 2.0. */
  async listSubsets(dimensionName: string, hierarchyName: string): Promise<Subset[]> {
    return this.subsets.list(dimensionName, hierarchyName);
  }

  /** @deprecated Use `client.subsets.get(dim, hier, name, isPrivate)` instead. Removed in 2.0. */
  async getSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    isPrivate = false,
  ): Promise<Subset> {
    return this.subsets.get(dimensionName, hierarchyName, subsetName, isPrivate);
  }

  /** @deprecated Use `client.subsets.create(dim, hier, subset)` instead. Removed in 2.0. */
  async createSubset(
    dimensionName: string,
    hierarchyName: string,
    subset: SubsetCreate,
  ): Promise<void> {
    return this.subsets.create(dimensionName, hierarchyName, subset);
  }

  /** @deprecated Use `client.subsets.update(dim, hier, name, update)` instead. Removed in 2.0. */
  async updateSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
    update: { expression?: string; elements?: string[]; alias?: string },
  ): Promise<void> {
    return this.subsets.update(dimensionName, hierarchyName, subsetName, update);
  }

  /** @deprecated Use `client.subsets.delete(dim, hier, name)` instead. Removed in 2.0. */
  async deleteSubset(
    dimensionName: string,
    hierarchyName: string,
    subsetName: string,
  ): Promise<void> {
    return this.subsets.delete(dimensionName, hierarchyName, subsetName);
  }

  // ── Element attribute values ─────────────────────────────────────────────

  /**
   * Read all attribute values for one element via MDX on }ElementAttributes_{Dim}.
   */
  /** @deprecated Use `client.elements.getAttributeValues(dim, name)` instead. Removed in 2.0. */
  async getElementAttributeValues(
    dimensionName: string,
    elementName: string,
  ): Promise<ElementAttributeValue[]> {
    return this.elements.getAttributeValues(dimensionName, elementName);
  }

  /** @deprecated Use `client.elements.updateAttributeValue(dim, name, attr, value)` instead. Removed in 2.0. */
  async updateElementAttributeValue(
    dimensionName: string,
    elementName: string,
    attributeName: string,
    value: number | string,
  ): Promise<void> {
    return this.elements.updateAttributeValue(dimensionName, elementName, attributeName, value);
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
  /** @deprecated Use `client.cubes.clear(cubeName, dimensions, tuples)` instead. Removed in 2.0. */
  async clearCube(
    cubeName: string,
    dimensions: string[],
    tuples: string[][],
  ): Promise<void> {
    return this.cubes.clear(cubeName, dimensions, tuples);
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
  /** @deprecated Use `client.cubes.unload(cubeName)` instead. Removed in 2.0. */
  async unloadCube(cubeName: string): Promise<void> {
    return this.cubes.unload(cubeName);
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
