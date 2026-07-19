// Process domain service. Owns the OData calls under /api/v1/Processes(...) —
// listing, executing, code/parameters/variables/datasource CRUD, plus the
// CompileProcess (server-side syntax check, with and without saving).
//
// See docs/ARCHITECTURE.md for the layering.
import { TM1Error, TM1ErrorCode } from "../../types.js";
import type {
  CompileResult,
  DataSource,
  Process,
  ProcessCheckInput,
  ProcessCode,
  ProcessParameter,
  ProcessResult,
  ProcessVariable,
} from "../../types.js";
import type { RequestOptions, TM1HttpClient } from "../http.js";
import { rethrowIfSystemic } from "./fallback.js";

// OData key encoder: double ' per OData literal rules, then percent-encode.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

// Encode a TI parameter for the OData write body.
//
// `Type` uses the tm1.ProcessVariableType enum (String=1, Numeric=2 — verified
// against the live $metadata). On v11 TM1 actually ignores this field and
// classifies the parameter from the JSON type of `Value`, so the decisive part
// is coercing `Value` to match the declared `type`: a Numeric parameter whose
// defaultValue arrived as the string "0" would otherwise be stored as String.
function encodeParameter(p: ProcessParameter): Record<string, unknown> {
  const numeric = p.type === "Numeric";
  let value: string | number;
  if (numeric) {
    const n = Number(p.defaultValue);
    value = Number.isFinite(n) ? n : 0;
  } else {
    value = String(p.defaultValue);
  }
  return {
    Name: p.name,
    Type: numeric ? 2 : 1,
    Value: value,
    ...(p.prompt ? { Prompt: p.prompt } : {}),
  };
}

export class ProcessService {
  constructor(private readonly http: TM1HttpClient) {}

  /**
   * List all TI processes with their parameters. Falls back to
   * Name-only when v11 rejects the inline Parameters select.
   * GET /api/v1/Processes?$select=Name,Parameters
   */
  async list(): Promise<Process[]> {
    // Parameters is a structural (complex) property, not a navigation property
    // — TM1 v11 rejects $expand=Parameters with a syntax error. Use $select
    // instead, which returns Parameters inline. Param.Type comes back as the
    // already-decoded string "Numeric" / "String" (not the legacy int code).
    try {
      const response = await this.http.request<{
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
    } catch (e) {
      rethrowIfSystemic(e);
      const response = await this.http.request<{
        value: Array<{ Name: string }>;
      }>("GET", "/api/v1/Processes?$select=Name");

      return response.value.map((p) => ({
        name: p.Name,
        parameters: [],
      }));
    }
  }

  /**
   * Execute a TI process with optional parameters. opts.timeoutMs overrides
   * the 30s default for long-running TI runs.
   * POST /api/v1/Processes('{name}')/tm1.ExecuteWithReturn
   */
  async execute(
    processName: string,
    params?: Record<string, string | number>,
    opts?: RequestOptions,
  ): Promise<ProcessResult> {
    const path = `/api/v1/Processes('${enc(processName)}')/tm1.ExecuteWithReturn`;
    const body: { Parameters?: Array<{ Name: string; Value: string | number }> } = {};
    if (params && Object.keys(params).length > 0) {
      body.Parameters = Object.entries(params).map(([name, value]) => ({
        Name: name,
        Value: value,
      }));
    }

    try {
      // ExecuteWithReturn returns HTTP 200 even when the process aborts; the
      // real outcome is in ProcessExecuteStatusCode. The plain tm1.Execute
      // action also 2xx-es on CompletedWithMinorErrors/HasMinorErrors, which
      // made partial failures (bad records + error log) invisible.
      const response = await this.http.request<{
        ProcessExecuteStatusCode?: string;
        ErrorLogFile?: { Filename?: string } | null;
      }>("POST", path, body, opts);
      const status = response?.ProcessExecuteStatusCode ?? "CompletedSuccessfully";
      return {
        success: status === "CompletedSuccessfully",
        processErrorStatus: status,
        errorLogFile: response?.ErrorLogFile?.Filename,
      };
    } catch (error) {
      // Systemic transport/auth failures (LOCK_TIMEOUT, CONNECTION_FAILED,
      // AUTH_FAILED) must propagate: a timed-out TI run is still executing
      // server-side, so reporting {success:false} would invite a duplicate run.
      rethrowIfSystemic(error);
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
   * Persist in-memory cube data to disk — SaveDataAll (all cubes) or
   * CubeSaveData (single cube). The REST API exposes no native SaveData
   * action ($metadata verified), so this routes through the service-root
   * ExecuteProcessWithReturn (available since 11.3) with an unbound TI
   * process — no persistent process object is created. v11-only: both TI
   * functions are removed in v12 (cloud engine persists automatically).
   * POST /api/v1/ExecuteProcessWithReturn
   */
  async saveData(cubeName?: string, opts?: RequestOptions): Promise<ProcessResult> {
    const prolog =
      cubeName !== undefined
        ? `CubeSaveData('${cubeName.replace(/'/g, "''")}');`
        : "SaveDataAll;";
    const body = {
      Process: {
        Name: "}tm1-mcp-save-data",
        HasSecurityAccess: false,
        PrologProcedure: prolog,
        MetadataProcedure: "",
        DataProcedure: "",
        EpilogProcedure: "",
        DataSource: { Type: "None" },
      },
    };

    try {
      const response = await this.http.request<{
        ProcessExecuteStatusCode?: string;
        ErrorLogFile?: { Filename?: string } | null;
      }>("POST", "/api/v1/ExecuteProcessWithReturn", body, opts);
      const status = response?.ProcessExecuteStatusCode ?? "CompletedSuccessfully";
      return {
        success: status === "CompletedSuccessfully",
        processErrorStatus: status,
        errorLogFile: response?.ErrorLogFile?.Filename,
      };
    } catch (error) {
      // Systemic transport/auth failures (LOCK_TIMEOUT, CONNECTION_FAILED,
      // AUTH_FAILED) must propagate: a timed-out TI run is still executing
      // server-side, so reporting {success:false} would invite a duplicate run.
      rethrowIfSystemic(error);
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
   * GET /api/v1/Processes('{name}')/Parameters
   */
  async getParameters(processName: string): Promise<ProcessParameter[]> {
    const path = `/api/v1/Processes('${enc(processName)}')/Parameters`;
    // TM1 v11 returns Type as the decoded string "Numeric" / "String"
    // (not the legacy int code 1 / 2). The old `=== 1` check silently
    // classified every Numeric parameter as String.
    const response = await this.http.request<{
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

  /**
   * Create a new empty TI process.
   * POST /api/v1/Processes with body {"Name": "..."}
   * Throws CONFLICT (409) if a process with the same name already exists.
   */
  async create(name: string): Promise<void> {
    await this.http.request<void>("POST", "/api/v1/Processes", { Name: name });
  }

  /**
   * Cheap existence probe: a single GET with $select=Name (404 → false)
   * instead of list(), which pulls every process plus its parameters just to
   * check one name. Rethrows anything that isn't NOT_FOUND.
   */
  async exists(name: string): Promise<boolean> {
    try {
      await this.http.request<{ Name: string }>(
        "GET",
        `/api/v1/Processes('${enc(name)}')?$select=Name`,
      );
      return true;
    } catch (e) {
      if (e instanceof TM1Error && e.code === TM1ErrorCode.NOT_FOUND) return false;
      throw e;
    }
  }

  /**
   * Copy a TI process to a new name. Strips read-only / server-managed fields
   * before re-POSTing to avoid TM1 rejecting the body.
   */
  async copy(sourceName: string, targetName: string): Promise<void> {
    const path = `/api/v1/Processes('${enc(sourceName)}')`;
    const source = await this.http.request<Record<string, unknown>>("GET", path);
    delete source["@odata.context"];
    delete source["@odata.etag"];
    delete source["Attributes"];
    delete source["LocalizedAttributes"];
    source.Name = targetName;
    await this.http.request<void>("POST", "/api/v1/Processes", source);
  }

  /**
   * Fetch every TI process with code AND parameter metadata for callgraph
   * indexing. Single round trip; falls back through 4 OData variants for
   * older/strict TM1 versions.
   */
  async fetchForCallgraph(includeControl = false): Promise<Array<{
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
        body = await this.http.request<{ value: Raw[] }>("GET", u);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!body) throw (lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "Processes fetch failed")));
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
   * GET /api/v1/Processes?$select=Name,PrologProcedure,...
   * Control processes (Name starts with `}`) excluded unless includeControl=true.
   *
   * With `top` set the cap is pushed server-side ($top + $orderby=Name for
   * stable ordering + $count=true) and the return carries the server-side
   * total matching the filter so callers can report truncation honestly.
   */
  async getAllCode(
    includeControl?: boolean,
  ): Promise<Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>>;
  async getAllCode(
    includeControl: boolean,
    top: number,
  ): Promise<{
    items: Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>;
    /** Server-side total ($count=true); undefined when the server omitted @odata.count. */
    total: number | undefined;
  }>;
  async getAllCode(
    includeControl = false,
    top?: number,
  ): Promise<
    | Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>
    | { items: Array<ProcessCode & { name: string; hasSecurityAccess: boolean }>; total: number | undefined }
  > {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const cap = top !== undefined ? `&$orderby=Name&$top=${top}&$count=true` : "";
    const path = `/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,HasSecurityAccess${filter}${cap}`;
    const response = await this.http.request<{
      "@odata.count"?: number;
      value: Array<{
        Name: string;
        PrologProcedure: string;
        MetadataProcedure: string;
        DataProcedure: string;
        EpilogProcedure: string;
        HasSecurityAccess?: boolean;
      }>;
    }>("GET", path);
    const items = response.value.map((p) => ({
      name: p.Name,
      prolog: p.PrologProcedure ?? "",
      metadata: p.MetadataProcedure ?? "",
      data: p.DataProcedure ?? "",
      epilog: p.EpilogProcedure ?? "",
      hasSecurityAccess: p.HasSecurityAccess === true,
    }));
    if (top !== undefined) {
      return { items, total: response["@odata.count"] };
    }
    return items;
  }

  /**
   * Get the code of all four tabs of a TI process.
   * GET /api/v1/Processes('{name}')
   */
  async getCode(processName: string): Promise<ProcessCode> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    const response = await this.http.request<{
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
   * Read deploy-relevant entity metadata not covered by getCode/params/
   * vars/datasource. Currently only HasSecurityAccess (functional elevation).
   * GET /api/v1/Processes('{name}')?$select=HasSecurityAccess
   */
  async getDeployMeta(
    processName: string,
  ): Promise<{ hasSecurityAccess: boolean }> {
    const path = `/api/v1/Processes('${enc(processName)}')?$select=HasSecurityAccess`;
    const response = await this.http.request<{
      HasSecurityAccess?: boolean;
    }>("GET", path);
    return { hasSecurityAccess: response.HasSecurityAccess === true };
  }

  /**
   * Update one or more code tabs of a TI process (partial update).
   * PATCH /api/v1/Processes('{name}') with only the tabs to update.
   */
  async updateCode(processName: string, code: Partial<ProcessCode>): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    const body: Record<string, string> = {};
    if (code.prolog !== undefined) body.PrologProcedure = code.prolog;
    if (code.metadata !== undefined) body.MetadataProcedure = code.metadata;
    if (code.data !== undefined) body.DataProcedure = code.data;
    if (code.epilog !== undefined) body.EpilogProcedure = code.epilog;

    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Read the whole process code as TM1's native `#region <Tab>` / `#endregion`
   * blob. GET /api/v1/Processes('{name}')/Code/$value (text/plain). Empty tabs
   * are omitted by the server; newlines are CRLF.
   */
  async getCodeBlob(processName: string): Promise<string> {
    const path = `/api/v1/Processes('${enc(processName)}')/Code/$value`;
    return this.http.requestRaw("GET", path);
  }

  /**
   * Write the whole process code from a native `#region` blob. PATCH
   * /api/v1/Processes('{name}') { Code }. The server parses the region markers
   * and does a FULL replace of all four tabs — tabs whose region is absent are
   * cleared. `$value` PUT is not supported by TM1, so this JSON PATCH is the
   * only write path.
   */
  async updateCodeBlob(processName: string, blob: string): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    await this.http.request<void>("PATCH", path, { Code: blob });
  }

  /**
   * Set HasSecurityAccess flag on process.
   * PATCH /api/v1/Processes('{name}') { HasSecurityAccess }.
   */
  async updateSecurityAccess(processName: string, hasSecurityAccess: boolean): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    await this.http.request<void>("PATCH", path, { HasSecurityAccess: hasSecurityAccess });
  }

  /**
   * Get the data source configuration of a TI process.
   * GET /api/v1/Processes('{name}') and extract the DataSource field.
   */
  async getDataSource(processName: string): Promise<DataSource> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    const response = await this.http.request<{
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
    // ds.Type is a raw string from the OData response. Surface (don't silently
    // swallow) a type this client version doesn't know — a future TM1 API
    // value would otherwise be cast to DataSource["type"] and could break a
    // downstream switch (e.g. the .pro serializer's type map). Pass it through
    // for forward-compat reads, but log so the gap is observable.
    const KNOWN_DATASOURCE_TYPES: ReadonlyArray<DataSource["type"]> = [
      "None", "TM1CubeView", "TM1DimensionSubset", "ASCII", "ODBC", "TM1Process",
    ];
    if (!KNOWN_DATASOURCE_TYPES.includes(ds.Type as DataSource["type"])) {
      this.http.logger.warn(
        { processName, dataSourceType: ds.Type },
        "Unknown TI datasource type from TM1; passing through unchanged",
      );
    }
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
      // Never surface the ODBC datasource password to the caller/LLM — return a
      // presence marker so the field stays observable without leaking the credential.
      ...(ds.password !== undefined ? { password: ds.password ? "[redacted]" : "" } : {}),
      ...(ds.oDBCConnection !== undefined ? { oDBCConnection: ds.oDBCConnection } : {}),
      ...(ds.query !== undefined ? { query: ds.query } : {}),
      ...(ds.view !== undefined ? { view: ds.view } : {}),
      ...(ds.subset !== undefined ? { subset: ds.subset } : {}),
    };
  }

  /**
   * Bulk-fetch the datasource of every process in one OData call, projected to
   * the few fields data-flow analysis needs (type + source object). Credentials
   * are never selected. Used by tm1_trace_data_flow to detect view-sourced reads
   * that leave no CellGet in the code and so never reach the reference index.
   * GET /api/v1/Processes?$select=Name,DataSource
   */
  async listDataSources(
    includeControl = false,
  ): Promise<Array<{ name: string; type: string; sourceName?: string; view?: string; subset?: string }>> {
    const filter = includeControl ? "" : "&$filter=not startswith(Name,'}')";
    const path = `/api/v1/Processes?$select=Name,DataSource${filter}`;
    const response = await this.http.request<{
      value: Array<{
        Name?: string;
        DataSource?: { Type?: string; dataSourceNameForServer?: string; view?: string; subset?: string };
      }>;
    }>("GET", path);
    return response.value
      .filter((p): p is { Name: string; DataSource?: { Type?: string; dataSourceNameForServer?: string; view?: string; subset?: string } } =>
        typeof p.Name === "string",
      )
      .map((p) => {
        const ds = p.DataSource;
        return {
          name: p.Name,
          type: ds?.Type ?? "None",
          ...(ds?.dataSourceNameForServer !== undefined ? { sourceName: ds.dataSourceNameForServer } : {}),
          ...(ds?.view !== undefined ? { view: ds.view } : {}),
          ...(ds?.subset !== undefined ? { subset: ds.subset } : {}),
        };
      });
  }

  /**
   * Update the data source configuration of a TI process.
   * PATCH /api/v1/Processes('{name}') with DataSource object.
   */
  async updateDataSource(processName: string, dataSource: DataSource): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
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
      if (this.http.version === 11) {
        this.http.logger.warn(
          { processName, tm1Version: this.http.tm1Version },
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

    await this.http.request<void>("PATCH", path, { DataSource: dsBody });
  }

  /**
   * Get the variables (column-mapped names) of a TI process.
   * GET /api/v1/Processes('{name}')/Variables
   */
  async getVariables(processName: string): Promise<ProcessVariable[]> {
    const path = `/api/v1/Processes('${enc(processName)}')/Variables`;
    const response = await this.http.request<{
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
   * Required after setting an ASCII DataSource.
   * PATCH /api/v1/Processes('{name}') with Variables array.
   */
  async updateVariables(processName: string, vars: ProcessVariable[]): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    const body = {
      Variables: vars.map((v) => ({
        Name: v.name,
        Type: v.type,
        Position: v.position,
        StartByte: v.startByte ?? 0,
        EndByte: v.endByte ?? 0,
      })),
    };
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Update the parameters of a TI process.
   * PATCH /api/v1/Processes('{name}') with Parameters array.
   */
  async updateParameters(processName: string, params: ProcessParameter[]): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    const body = {
      Parameters: params.map(encodeParameter),
    };
    await this.http.request<void>("PATCH", path, body);
  }

  /**
   * Delete a TI process.
   * DELETE /api/v1/Processes('{name}')
   */
  async delete(processName: string): Promise<void> {
    const path = `/api/v1/Processes('${enc(processName)}')`;
    await this.http.request<void>("DELETE", path);
  }

  /**
   * Compile a saved TI process to check syntax without executing it.
   * POST /api/v1/Processes('{name}')/tm1.Compile
   */
  async compile(processName: string): Promise<CompileResult> {
    const path = `/api/v1/Processes('${enc(processName)}')/tm1.Compile`;
    try {
      const response = await this.http.request<{
        value?: Array<{ LineNumber?: number; Procedure?: string; Message?: string }>;
      }>("POST", path, {});
      const errors = (response?.value ?? []).map((e) => ({
        lineNumber: e.LineNumber,
        procedure: e.Procedure,
        message: e.Message ?? "",
      }));
      return { success: errors.length === 0, errors };
    } catch (err) {
      // Systemic transport/auth failures must propagate rather than be reported
      // as a compile failure — an outage is not a broken process.
      rethrowIfSystemic(err);
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
   * Validate a TI process WITHOUT saving it on the server. Mirrors tm1py's
   * compile_process_with_body. Returns CompileResult identical to compile()
   * for callers that already handle that shape.
   * POST /api/v1/CompileProcess body { Process: <full process body> }
   */
  async check(input: ProcessCheckInput): Promise<CompileResult> {
    const path = "/api/v1/CompileProcess";

    const processBody: Record<string, unknown> = {
      Name: input.name ?? "_compile_check",
      PrologProcedure: input.prolog ?? "",
      MetadataProcedure: input.metadata ?? "",
      DataProcedure: input.data ?? "",
      EpilogProcedure: input.epilog ?? "",
    };

    if (input.parameters) {
      processBody.Parameters = input.parameters.map(encodeParameter);
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
      // usesUnicode: same v11 quirk as updateDataSource — drop on TM1 11.x.
      if (ds.usesUnicode !== undefined && this.http.version !== 11) {
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
      const response = await this.http.request<{
        value?: Array<{ LineNumber?: number; Procedure?: string; Message?: string }>;
      }>("POST", path, { Process: processBody });
      const errors = (response?.value ?? []).map((e) => ({
        lineNumber: e.LineNumber,
        procedure: e.Procedure,
        message: e.Message ?? "",
      }));
      return { success: errors.length === 0, errors };
    } catch (err) {
      // Systemic transport/auth failures must propagate rather than be reported
      // as a compile failure — an outage is not a broken process.
      rethrowIfSystemic(err);
      if (err instanceof TM1Error) {
        return {
          success: false,
          errors: [{ message: err.details ?? err.message }],
        };
      }
      throw err;
    }
  }
}
