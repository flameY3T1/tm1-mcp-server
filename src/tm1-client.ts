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
import { ProcessService } from "./tm1-client/services/process-service.js";
import { ChoreService } from "./tm1-client/services/chore-service.js";
import { SecurityService } from "./tm1-client/services/security-service.js";
import { ServerService } from "./tm1-client/services/server-service.js";
import { MonitoringService } from "./tm1-client/services/monitoring-service.js";
import { FileService } from "./tm1-client/services/file-service.js";

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
  readonly processes: ProcessService;
  readonly chores: ChoreService;
  readonly security: SecurityService;
  readonly server: ServerService;
  readonly monitoring: MonitoringService;
  readonly files: FileService;

  constructor(config: TM1Config, sessionManager: SessionManager, logger: pino.Logger) {
    super(config, sessionManager, logger);
    this.cubes = new CubeService(this);
    this.dimensions = new DimensionService(this);
    this.hierarchies = new HierarchyService(this);
    this.cells = new CellService(this);
    this.views = new ViewService(this);
    this.subsets = new SubsetService(this);
    this.elements = new ElementService(this, this.cells);
    this.processes = new ProcessService(this);
    this.chores = new ChoreService(this);
    this.security = new SecurityService(this);
    this.server = new ServerService(this);
    this.monitoring = new MonitoringService(this);
    this.files = new FileService(this);
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
  /** @deprecated Use `client.processes.list()` instead. Removed in 2.0. */
  async getProcesses(): Promise<Process[]> {
    return this.processes.list();
  }

  /**
   * List all chores with their tasks.
   * GET /api/v1/Chores?$expand=Tasks
   */
  /** @deprecated Use `client.chores.list()` instead. Removed in 2.0. */
  async getChores(): Promise<Chore[]> {
    return this.chores.list();
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
  /** @deprecated Use `client.processes.execute(name, params, opts)` instead. Removed in 2.0. */
  async executeProcess(
    processName: string,
    params?: Record<string, string | number>,
    opts?: { timeoutMs?: number },
  ): Promise<ProcessResult> {
    return this.processes.execute(processName, params, opts);
  }

  /**
   * Get the parameters of a TI process.
   * GET /api/v1/Processes('{processName}')/Parameters
   */
  /** @deprecated Use `client.processes.getParameters(processName)` instead. Removed in 2.0. */
  async getProcessParameters(processName: string): Promise<ProcessParameter[]> {
    return this.processes.getParameters(processName);
  }

  // ── TI development methods ──────────────────────────────────────────────

  /**
   * Create a new empty TI process.
   * POST /api/v1/Processes with body {"Name": "..."}
   * Throws CONFLICT (409) if a process with the same name already exists.
   */
  /** @deprecated Use `client.processes.create(name)` instead. Removed in 2.0. */
  async createProcess(name: string): Promise<void> {
    return this.processes.create(name);
  }

  /** @deprecated Use `client.processes.copy(source, target)` instead. Removed in 2.0. */
  async copyProcess(sourceName: string, targetName: string): Promise<void> {
    return this.processes.copy(sourceName, targetName);
  }

  /**
   * Fetch every TI process with code AND parameter metadata for callgraph
   * indexing. Single round trip; falls back through 4 OData variants for
   * older/strict TM1 versions.
   */
  /** @deprecated Use `client.processes.fetchForCallgraph(includeControl)` instead. Removed in 2.0. */
  async fetchProcessesForCallgraph(includeControl = false): Promise<Array<{
    name: string;
    prolog: string;
    metadata: string;
    data: string;
    epilog: string;
    parameters: string[];
    parameterDefaults: Map<string, string>;
  }>> {
    return this.processes.fetchForCallgraph(includeControl);
  }

  /**
   * Bulk-fetch code for every TI process in a single round trip.
   * GET /api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure
   * Control processes (Name starts with `}`) excluded unless includeControl=true.
   */
  /** @deprecated Use `client.processes.getAllCode(includeControl)` instead. Removed in 2.0. */
  async getAllProcessesCode(includeControl = false): Promise<Array<ProcessCode & { name: string }>> {
    return this.processes.getAllCode(includeControl);
  }

  /** @deprecated Use `client.processes.getCode(processName)` instead. Removed in 2.0. */
  async getProcessCode(processName: string): Promise<ProcessCode> {
    return this.processes.getCode(processName);
  }

  /** @deprecated Use `client.processes.updateCode(processName, code)` instead. Removed in 2.0. */
  async updateProcessCode(processName: string, code: Partial<ProcessCode>): Promise<void> {
    return this.processes.updateCode(processName, code);
  }

  /**
   * Get the data source configuration of a TI process.
   * GET /api/v1/Processes('{name}') and extract the DataSource field.
   */
  /** @deprecated Use `client.processes.getDataSource(processName)` instead. Removed in 2.0. */
  async getProcessDataSource(processName: string): Promise<DataSource> {
    return this.processes.getDataSource(processName);
  }

  /** @deprecated Use `client.processes.updateDataSource(processName, ds)` instead. Removed in 2.0. */
  async updateProcessDataSource(processName: string, dataSource: DataSource): Promise<void> {
    return this.processes.updateDataSource(processName, dataSource);
  }

  /**
   * Get the variables (column-mapped names) of a TI process.
   * GET /api/v1/Processes('{name}')/Variables
   */
  /** @deprecated Use `client.processes.getVariables(processName)` instead. Removed in 2.0. */
  async getProcessVariables(processName: string): Promise<ProcessVariable[]> {
    return this.processes.getVariables(processName);
  }

  /** @deprecated Use `client.processes.updateVariables(processName, vars)` instead. Removed in 2.0. */
  async updateProcessVariables(processName: string, vars: ProcessVariable[]): Promise<void> {
    return this.processes.updateVariables(processName, vars);
  }

  /** @deprecated Use `client.processes.updateParameters(processName, params)` instead. Removed in 2.0. */
  async updateProcessParameters(processName: string, params: ProcessParameter[]): Promise<void> {
    return this.processes.updateParameters(processName, params);
  }

  /** @deprecated Use `client.processes.delete(processName)` instead. Removed in 2.0. */
  async deleteProcess(processName: string): Promise<void> {
    return this.processes.delete(processName);
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
  /** @deprecated Use `client.server.getMessageLog(top)` instead. Removed in 2.0. */
  async getMessageLog(top = 100): Promise<MessageLogEntry[]> {
    return this.server.getMessageLog(top);
  }

  /**
   * List TI process error log files.
   * GET /api/v1/ErrorLogFiles
   * TM1 v11 OData exposes only `Filename` on this entity set (no LastUpdated/$select/$orderby
   * support). Sorting is filename-descending — filenames embed a yyyymmddhhmmss timestamp,
   * so lexical desc sort matches chronological newest-first.
   */
  /** @deprecated Use `client.server.listErrorLogFiles(opts)` instead. Removed in 2.0. */
  async getErrorLogFiles(opts: { processName?: string; since?: string; top?: number } = {}): Promise<ErrorLogFile[]> {
    return this.server.listErrorLogFiles(opts);
  }

  /** @deprecated Use `client.server.getErrorLogContent(filename)` instead. Removed in 2.0. */
  async getErrorLogContent(filename: string): Promise<string> {
    return this.server.getErrorLogContent(filename);
  }

  /**
   * List all active threads on the TM1 server.
   * GET /api/v1/Threads
   */
  /** @deprecated Use `client.monitoring.getThreads()` instead. Removed in 2.0. */
  async getThreads(): Promise<Thread[]> {
    return this.monitoring.getThreads();
  }

  /** @deprecated Use `client.monitoring.cancelThread(threadId)` instead. Removed in 2.0. */
  async cancelThread(threadId: number): Promise<void> {
    return this.monitoring.cancelThread(threadId);
  }

  /** @deprecated Use `client.monitoring.getSessions()` instead. Removed in 2.0. */
  async getSessions(): Promise<Session[]> {
    return this.monitoring.getSessions();
  }

  // ── Scheduling methods ────────────────────────────────────────────────────

  /**
   * Activate or deactivate a chore.
   * PATCH /api/v1/Chores('{name}') with { Active: bool }
   */
  /** @deprecated Use `client.chores.toggleActive(choreName, active)` instead. Removed in 2.0. */
  async toggleChoreActive(choreName: string, active: boolean): Promise<void> {
    return this.chores.toggleActive(choreName, active);
  }

  /** @deprecated Use `client.chores.execute(choreName, opts)` instead. Removed in 2.0. */
  async executeChore(choreName: string, opts?: { timeoutMs?: number }): Promise<void> {
    return this.chores.execute(choreName, opts);
  }

  /** @deprecated Use `client.chores.create(chore)` instead. Removed in 2.0. */
  async createChore(chore: ChoreCreate): Promise<void> {
    return this.chores.create(chore);
  }

  /** @deprecated Use `client.chores.update(choreName, updates)` instead. Removed in 2.0. */
  async updateChore(choreName: string, updates: Partial<Pick<ChoreCreate, "startTime" | "active" | "dstSensitive" | "executionMode" | "frequency" | "steps">>): Promise<void> {
    return this.chores.update(choreName, updates);
  }

  /** @deprecated Use `client.chores.delete(choreName)` instead. Removed in 2.0. */
  async deleteChore(choreName: string): Promise<void> {
    return this.chores.delete(choreName);
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
  /** @deprecated Use `client.files.list(path)` instead. Removed in 2.0. */
  async listFiles(path?: string): Promise<string[]> {
    return this.files.list(path);
  }

  /** @deprecated Use `client.files.getContent(fileName)` instead. Removed in 2.0. */
  async getFileContent(fileName: string): Promise<string> {
    return this.files.getContent(fileName);
  }

  // ── Server info ──────────────────────────────────────────────────────────

  /**
   * Fetch TM1 server configuration. Merges /Configuration and /ActiveConfiguration.
   */
  /** @deprecated Use `client.server.getInfo()` instead. Removed in 2.0. */
  async getServerInfo(): Promise<ServerInfo> {
    return this.server.getInfo();
  }

  // ── TI development (compile) ─────────────────────────────────────────────

  /**
   * Compile a TI process to check its syntax without executing it.
   * POST /api/v1/Processes('{name}')/tm1.Compile
   */
  /** @deprecated Use `client.processes.compile(processName)` instead. Removed in 2.0. */
  async compileProcess(processName: string): Promise<CompileResult> {
    return this.processes.compile(processName);
  }

  /**
   * Validate a TI process WITHOUT saving it on the server.
   * POST /api/v1/CompileProcess body { Process: <full process body> }.
   * Mirrors tm1py's compile_process_with_body. Returns CompileResult identical
   * to compileProcess() for callers that already handle that shape.
   */
  /** @deprecated Use `client.processes.check(input)` instead. Removed in 2.0. */
  async checkProcessCode(input: ProcessCheckInput): Promise<CompileResult> {
    return this.processes.check(input);
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
  /** @deprecated Use `client.server.getTransactionLog(opts)` instead. Removed in 2.0. */
  async getTransactionLog(opts: {
    top?: number;
    cubeName?: string;
    user?: string;
    since?: string;
  }): Promise<TransactionLogEntry[]> {
    return this.server.getTransactionLog(opts);
  }

  // --- Security: Users (Clients) ---
  // TM1 11.8 uses /api/v1/Users (not /Clients). Tool names retain "client"
  // for backward-compatibility with the MCP surface.

  /** @deprecated Use `client.security.listClients()` instead. Removed in 2.0. */
  async listClients(): Promise<Client[]> {
    return this.security.listClients();
  }

  /** @deprecated Use `client.security.getClient(name)` instead. Removed in 2.0. */
  async getClient(name: string): Promise<Client> {
    return this.security.getClient(name);
  }

  /** @deprecated Use `client.security.createClient(payload)` instead. Removed in 2.0. */
  async createClient(payload: ClientCreate): Promise<void> {
    return this.security.createClient(payload);
  }

  /** @deprecated Use `client.security.updateClient(name, payload)` instead. Removed in 2.0. */
  async updateClient(name: string, payload: ClientUpdate): Promise<void> {
    return this.security.updateClient(name, payload);
  }

  /** @deprecated Use `client.security.deleteClient(name)` instead. Removed in 2.0. */
  async deleteClient(name: string): Promise<void> {
    return this.security.deleteClient(name);
  }

  /** @deprecated Use `client.security.listGroups()` instead. Removed in 2.0. */
  async listGroups(): Promise<Group[]> {
    return this.security.listGroups();
  }

  /** @deprecated Use `client.security.assignClientGroup(client, group)` instead. Removed in 2.0. */
  async assignClientGroup(clientName: string, groupName: string): Promise<void> {
    return this.security.assignClientGroup(clientName, groupName);
  }

  /** @deprecated Use `client.security.removeClientGroup(client, group)` instead. Removed in 2.0. */
  async removeClientGroup(clientName: string, groupName: string): Promise<void> {
    return this.security.removeClientGroup(clientName, groupName);
  }
}
