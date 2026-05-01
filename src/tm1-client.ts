import type { TM1Config } from "./config.js";
import type { SessionManager } from "./session-manager.js";
import { TM1Error, TM1ErrorCode } from "./types.js";
import type { Cube, Dimension, Hierarchy, HierarchyElement, Process, ProcessParameter, ProcessVariable, ProcessResult, ProcessCode, DataSource, Chore, CellValue, MdxResult, MdxAxis, ViewResult, ElementCreate, ElementUpdate, Thread, MessageLogEntry, CubeRules, ChoreCreate, ServerInfo, CompileResult, ProcessCheckInput, CubeView, TransactionLogEntry, Subset, SubsetCreate, ElementAttributeValue, Client, ClientCreate, ClientUpdate, Group, Session, RuleSyntaxError } from "./types.js";
import type pino from "pino";

const MAX_NETWORK_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const USER_AGENT = "tm1-mcp-server/0.1.0";

export class TM1Client {
  private readonly config: TM1Config;
  private readonly sessionManager: SessionManager;
  private readonly logger: pino.Logger;
  private connected = false;

  constructor(
    config: TM1Config,
    sessionManager: SessionManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
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

  /**
   * Make an authenticated HTTP request to the TM1 REST API.
   *
   * - Ensures an active session via SessionManager
   * - On 401: re-authenticates once and retries
   * - On network error for safe methods (GET/HEAD): retries up to 3 times with exponential backoff (1s, 2s, 4s)
   * - On network error for non-safe methods (POST/PUT/PATCH/DELETE): does NOT retry — these are not idempotent
   *   and a retry could spawn duplicate side-effects (e.g. parallel TI runs on tm1.Execute)
   * - On other HTTP errors: classifies and throws TM1Error
   */
  protected async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const isSafeMethod = method === "GET" || method === "HEAD";
    const maxAttempts = isSafeMethod ? MAX_NETWORK_RETRIES : 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          { attempt, delayMs, endpoint: path },
          "Retrying after network error",
        );
        await sleep(delayMs);
      }

      try {
        const cookie = await this.sessionManager.ensureSession();
        const response = await this.executeRequest(url, method, cookie, body);

        // 401 → re-auth once and retry the request
        if (response.status === 401) {
          this.logger.warn({ endpoint: path }, "Received 401, re-authenticating");
          const newCookie = await this.sessionManager.authenticate();
          const retryResponse = await this.executeRequest(
            url,
            method,
            newCookie,
            body,
          );

          if (retryResponse.status === 401) {
            throw new TM1Error({
              code: TM1ErrorCode.AUTH_FAILED,
              message: "Authentication failed after re-authentication attempt",
              httpStatus: 401,
              endpoint: path,
            });
          }

          return this.handleResponse<T>(retryResponse, path);
        }

        return this.handleResponse<T>(response, path);
      } catch (error) {
        if (error instanceof TM1Error) {
          throw error;
        }

        if (this.isNetworkError(error)) {
          lastError = error;
          this.logger.error(
            { err: error, attempt, endpoint: path },
            "Network error during request",
          );
          continue; // retry
        }

        // Unknown error – don't retry
        throw new TM1Error({
          code: TM1ErrorCode.CONNECTION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          endpoint: path,
        });
      }
    }

    // All retries exhausted (or no retries attempted for non-safe methods)
    throw new TM1Error({
      code: TM1ErrorCode.CONNECTION_FAILED,
      message: isSafeMethod
        ? `Request failed after ${MAX_NETWORK_RETRIES} retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `Request failed (no retry for ${method}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      endpoint: path,
    });
  }

  // ── Metadata methods ──────────────────────────────────────────────────────

  /**
   * List all cubes with their dimension names.
   * GET /api/v1/Cubes?$expand=Dimensions($select=Name)
   */
  async getCubes(): Promise<Cube[]> {
    const response = await this.request<{ value: Array<{ Name: string; Dimensions: Array<{ Name: string }> }> }>(
      "GET",
      "/api/v1/Cubes?$expand=Dimensions($select=Name)",
    );
    return response.value.map((c) => ({
      name: c.Name,
      dimensions: c.Dimensions.map((d) => d.Name),
    }));
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
   */
  async getHierarchy(dimensionName: string, hierarchyName: string): Promise<Hierarchy> {
    // TM1 11.8 does not expose `Children` on Element — only `Parents`. Fetch Parents
    // and derive children server-side. Weight defaults to 1 (actual weights live on
    // /Edges; not fetched here to keep the query cheap).
    const path = `/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')?$expand=Elements($select=Name,Type,Level;$expand=Parents($select=Name))`;
    const response = await this.request<{
      Name: string;
      Elements: Array<{
        Name: string;
        Type: string;
        Level: number;
        Parents?: Array<{ Name: string }>;
      }>;
    }>("GET", path);

    const childrenByParent = new Map<string, Array<{ name: string; weight: number }>>();
    for (const e of response.Elements) {
      for (const p of e.Parents ?? []) {
        const list = childrenByParent.get(p.Name) ?? [];
        list.push({ name: e.Name, weight: 1 });
        childrenByParent.set(p.Name, list);
      }
    }

    const elements: HierarchyElement[] = response.Elements.map((e) => ({
      name: e.Name,
      type: e.Type as HierarchyElement["type"],
      level: e.Level,
      parents: (e.Parents ?? []).map((p) => p.Name),
      children: childrenByParent.get(e.Name) ?? [],
    }));

    return {
      name: response.Name,
      dimensionName,
      elements,
    };
  }

  /**
   * List all TI processes with their parameters.
   * GET /api/v1/Processes?$expand=Parameters
   */
  async getProcesses(): Promise<Process[]> {
    // First try with $expand=Parameters, fall back to plain list if server doesn't support it
    try {
      const response = await this.request<{
        value: Array<{
          Name: string;
          Parameters: Array<{
            Name: string;
            Type: number;
            Value: string | number;
            Prompt?: string;
          }>;
        }>;
      }>("GET", "/api/v1/Processes?$expand=Parameters");

      return response.value.map((p) => ({
        name: p.Name,
        parameters: p.Parameters.map((param): ProcessParameter => ({
          name: param.Name,
          type: param.Type === 1 ? "Numeric" : "String",
          defaultValue: param.Value,
          ...(param.Prompt ? { prompt: param.Prompt } : {}),
        })),
      }));
    } catch {
      // Fallback: load processes without parameters (for servers that don't support $expand on Parameters)
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
    const colMember = `[${elements[0]}]`;
    const whereParts = elements.slice(1).map((e) => `[${e}]`);
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

    const response = await this.request<{
      value: Array<{
        Name: string;
        Type: number;
        Value: string | number;
        Prompt?: string;
      }>;
    }>("GET", path);

    return response.value.map((param): ProcessParameter => ({
      name: param.Name,
      type: param.Type === 1 ? "Numeric" : "String",
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
        ID: string;
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
      id: s.ID,
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

  /**
   * Make an authenticated HTTP request that returns raw text (not JSON).
   * Used for file content downloads where the response is CSV/TXT/etc.
   * Re-auths once on 401 like request().
   */
  private async requestRaw(method: string, path: string): Promise<string> {
    const url = `${this.config.baseUrl}${path}`;
    const cookie = await this.sessionManager.ensureSession();

    const doFetch = async (c: string): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        return await fetch(url, {
          method,
          headers: {
            Cookie: `TM1SessionId=${c}`,
            Accept: "*/*",
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };

    let response = await doFetch(cookie);
    if (response.status === 401) {
      const newCookie = await this.sessionManager.authenticate();
      response = await doFetch(newCookie);
    }
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* ignore */ }
      throw this.classifyHttpError(response.status, path, body || undefined);
    }
    return response.text();
  }

  private async executeRequest(
    url: string,
    method: string,
    cookie: string,
    body?: unknown,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );

    const headers: Record<string, string> = {
      Cookie: `TM1SessionId=${cookie}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "TM1-SessionContext": USER_AGENT,
      "TM1-Session-Context": USER_AGENT,
    };

    // TM1 requires Content-Type for any write method, including POSTs
    // with empty body such as `tm1.Execute` actions.
    const isWriteMethod = method === "POST" || method === "PUT" || method === "PATCH";
    if (body !== undefined || isWriteMethod) {
      headers["Content-Type"] = "application/json";
    }

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : isWriteMethod ? "" : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async handleResponse<T>(
    response: Response,
    endpoint: string,
  ): Promise<T> {
    if (response.ok) {
      // Always consume the body to release the connection
      const text = await response.text();

      // 204 No Content or empty body
      if (response.status === 204 || !text) {
        return undefined as T;
      }

      this.logger.debug(
        { endpoint, status: response.status },
        "Request successful",
      );
      return JSON.parse(text) as T;
    }

    // Extract error details from TM1 response body
    // Always consume the body to release the connection
    let details: string | undefined;
    let errorBody = "";
    try {
      errorBody = await response.text();
      if (errorBody) {
        const parsed = JSON.parse(errorBody);
        details = parsed?.error?.message?.value ?? parsed?.error?.message ?? errorBody;
      }
    } catch {
      // ignore parse errors, body is already consumed
    }

    const error = this.classifyHttpError(response.status, endpoint, details);
    this.logger.error(
      { endpoint, status: response.status, code: error.code },
      error.message,
    );
    throw error;
  }

  private classifyHttpError(
    status: number,
    endpoint: string,
    details?: string,
  ): TM1Error {
    switch (status) {
      case 401:
        return new TM1Error({
          code: TM1ErrorCode.AUTH_FAILED,
          message: details ?? "Authentication failed",
          httpStatus: status,
          endpoint,
          details,
        });
      case 403:
        return new TM1Error({
          code: TM1ErrorCode.PERMISSION_DENIED,
          message: details ?? "Permission denied",
          httpStatus: status,
          endpoint,
          details,
        });
      case 404:
        return new TM1Error({
          code: TM1ErrorCode.NOT_FOUND,
          message: details ?? "Resource not found",
          httpStatus: status,
          endpoint,
          details,
        });
      case 409:
        return new TM1Error({
          code: TM1ErrorCode.CONFLICT,
          message: details ?? "Resource conflict",
          httpStatus: status,
          endpoint,
          details,
        });
      default:
        return new TM1Error({
          code: TM1ErrorCode.TM1_ERROR,
          message: details ?? `TM1 API error (HTTP ${status})`,
          httpStatus: status,
          endpoint,
          details,
        });
    }
  }

  private isNetworkError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") {
      return true;
    }
    if (error instanceof TypeError) {
      // fetch throws TypeError for network failures (DNS, connection refused, etc.)
      return true;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes("fetch failed") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("etimedout") ||
        msg.includes("network")
      );
    }
    return false;
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
    const res = await this.request<{ value: Group[] }>(
      "GET",
      "/api/v1/Groups",
    );
    return res.value;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
