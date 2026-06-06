// ── Error codes ──────────────────────────────────────────────────────────────

export const TM1ErrorCode = {
  CONNECTION_FAILED: "CONNECTION_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  TM1_ERROR: "TM1_ERROR",
  UNSUPPORTED_OPERATION: "UNSUPPORTED_OPERATION",
} as const;

export type TM1ErrorCode = (typeof TM1ErrorCode)[keyof typeof TM1ErrorCode];

// ── TM1Error ─────────────────────────────────────────────────────────────────

export class TM1Error extends Error {
  readonly code: TM1ErrorCode;
  readonly httpStatus?: number | undefined;
  readonly endpoint?: string | undefined;
  readonly details?: string | undefined;
  // Optional tool-context override. When set, takes precedence over
  // hintForCode(). Tools attach this via attachHint() to provide
  // operation-specific next steps (G4 from MCP best-practices review).
  hintOverride?: string | undefined;

  constructor(opts: {
    code: TM1ErrorCode;
    message: string;
    httpStatus?: number | undefined;
    endpoint?: string | undefined;
    details?: string | undefined;
    hint?: string | undefined;
  }) {
    super(opts.message);
    this.name = "TM1Error";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.endpoint = opts.endpoint;
    this.details = opts.details;
    this.hintOverride = opts.hint;
  }

  // Actionable next-step suggestion for an LLM agent. Tool-context override
  // wins over the generic code-derived hint.
  get hint(): string {
    return this.hintOverride ?? hintForCode(this.code);
  }

  toErrorPayload(): {
    code: TM1ErrorCode;
    message: string;
    httpStatus?: number | undefined;
    endpoint?: string | undefined;
    details?: string | undefined;
    hint: string;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.httpStatus !== undefined && { httpStatus: this.httpStatus }),
      ...(this.endpoint !== undefined && { endpoint: this.endpoint }),
      ...(this.details !== undefined && { details: this.details }),
      hint: this.hint,
    };
  }
}

export function hintForCode(code: TM1ErrorCode | string): string {
  switch (code) {
    case TM1ErrorCode.AUTH_FAILED:
      return "Re-check TM1_USER/TM1_PASSWORD env vars; call tm1_get_server_info to verify reach.";
    case TM1ErrorCode.PERMISSION_DENIED:
      return "Caller lacks rights for this object/operation. Inspect membership via tm1_list_groups and assign with tm1_assign_client_group.";
    case TM1ErrorCode.NOT_FOUND:
      return "Object does not exist. Use the matching list_* or get_* tool to enumerate available names before retrying.";
    case TM1ErrorCode.CONFLICT:
      return "Object already exists or version mismatch. Fetch current state with the matching get_* tool, then retry.";
    case TM1ErrorCode.VALIDATION_ERROR:
      return "Input failed validation. Inspect the `details` field for the offending value and correct it.";
    case TM1ErrorCode.UNSUPPORTED_OPERATION:
      return "TM1 server version may not support this. Call tm1_get_server_info to check the version.";
    case TM1ErrorCode.CONNECTION_FAILED:
      return "TM1 server unreachable. Verify TM1_BASE_URL/TM1_HOST/TM1_PORT and that the service is running.";
    case TM1ErrorCode.TM1_ERROR:
      return "Generic TM1 error. Inspect `details` for the raw server message.";
    default:
      return "Unexpected error. Inspect `message`/`details` and retry with corrected input.";
  }
}

// ── Domain models ────────────────────────────────────────────────────────────

export interface Cube {
  name: string;
  dimensions: string[];
  hasRules?: boolean;
}

export interface ElementStats {
  total: number;
  numeric: number;
  consolidated: number;
  string: number;
  maxLevel: number;
}

export interface Dimension {
  name: string;
  hierarchies: string[];
  // Populated only when getDimensions({includeElementCount: true}) is called.
  // Map hierarchyName → element total. Cheap audit signal — avoids per-hierarchy round-trips.
  elementCounts?: Record<string, number>;
  // Populated only when getDimensions({includeElementStats: true}) is called.
  // Per-hierarchy Type breakdown (N/C/S) + maxLevel. Drives orphan & double-hierarchy detection
  // without cube/MDX dependency.
  elementStats?: Record<string, ElementStats>;
}

export interface Hierarchy {
  name: string;
  dimensionName: string;
  elements: HierarchyElement[];
}

export interface HierarchyElement {
  name: string;
  type: "Numeric" | "String" | "Consolidated";
  level: number;
  parents: string[];
  children: Array<{ name: string; weight: number }>;
}

export type CellValue = string | number | null;

export interface MdxResult {
  cells: Array<{ value: CellValue; formattedValue: string }>;
  axes: MdxAxis[];
  totalCellCount: number;
}

export interface MdxAxis {
  tuples: Array<{
    members: Array<{ name: string; hierarchyName: string }>;
  }>;
}

// Feeder / calculation tracing (tm1.CheckFeeders / TraceFeeders /
// TraceCellCalculation, all v11; bound to Cube, keyed by element tuple).
export interface FedCellDescriptor {
  cube: string;
  tuple: string[];
  fed: boolean;
}

export interface FeederTraceResult {
  fedCells: FedCellDescriptor[];
  statements: string[];
}

export interface CalculationTraceNode {
  type?: string;
  status?: string;
  value: CellValue;
  cube?: string;
  tuple?: string[];
  statements?: string[];
  components?: CalculationTraceNode[];
  /** Set when children were cut off by maxDepth / maxComponents. */
  truncated?: boolean;
}

export interface ViewResult {
  cubeName: string;
  viewName: string;
  cells: Array<{ value: CellValue; formattedValue: string }>;
  axes: MdxAxis[];
}

export interface ViewAxisSubsetRef {
  dimensionName?: string | undefined;
  hierarchyName?: string | undefined;
  subsetName?: string | undefined;
  expression?: string | undefined;
}

export interface ViewTitleRef extends ViewAxisSubsetRef {
  selectedElement?: string | undefined;
}

export interface NativeViewDefinition {
  titles: ViewTitleRef[];
  columns: ViewAxisSubsetRef[];
  rows: ViewAxisSubsetRef[];
}

export interface ViewDefinition {
  cubeName: string;
  viewName: string;
  private: boolean;
  type: "MDX" | "Native";
  mdx?: string;
  native?: NativeViewDefinition;
}

export interface Process {
  name: string;
  parameters: ProcessParameter[];
}

export interface ProcessParameter {
  name: string;
  type: "String" | "Numeric";
  defaultValue: string | number;
  prompt?: string | undefined;
}

export interface ProcessVariable {
  name: string;
  type: "String" | "Numeric";
  position: number;
  startByte?: number | undefined;
  endByte?: number | undefined;
}

export interface ProcessCode {
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
}

export interface DataSource {
  type:
    | "None"
    | "TM1CubeView"
    | "TM1DimensionSubset"
    | "ASCII"
    | "ODBC"
    | "TM1Process";
  dataSourceNameForServer?: string | undefined;
  dataSourceNameForClient?: string | undefined;
  asciiDelimiterType?: string | undefined;
  asciiDelimiterChar?: string | undefined;
  asciiQuoteCharacter?: string | undefined;
  asciiHeaderRecords?: number | undefined;
  asciiDecimalSeparator?: string | undefined;
  asciiThousandSeparator?: string | undefined;
  usesUnicode?: boolean | undefined;
  userName?: string | undefined;
  password?: string | undefined;
  oDBCConnection?: string | undefined;
  query?: string | undefined;
  view?: string | undefined;
  subset?: string | undefined;
}

export interface ProcessResult {
  success: boolean;
  processErrorStatus: string;
  errorLogFile?: string | undefined;
}

export interface Chore {
  name: string;
  active: boolean;
  startTime: string;
  frequency: string;
  processes: Array<{
    name: string;
    parameters: Record<string, string | number>;
  }>;
}

export interface ElementCreate {
  name: string;
  type: "Numeric" | "String" | "Consolidated";
  components?: Array<{ name: string; weight: number }> | undefined;
}

export interface ElementUpdate {
  newName?: string | undefined;
  type?: "Numeric" | "String" | "Consolidated" | undefined;
  components?: Array<{ name: string; weight: number }> | undefined;
}

// ── New domain models (Phase 1) ───────────────────────────────────────────────

export interface Thread {
  id: number;
  type: string;
  name: string;
  state: string;
  function: string;
  objectName: string;
  elapsedTime?: string | undefined;
  objectType?: string | undefined;
  lockType?: string | undefined;
  waitTime?: string | undefined;
  info?: string | undefined;
  context?: string | undefined;
}

export interface Session {
  id: string;
  user: string;
  active?: boolean;
  threads: Thread[];
}

export interface RuleSyntaxError {
  message: string;
  lineNumber?: number;
}

export interface MessageLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface CubeRules {
  cubeName: string;
  rulesText: string;
  skipCheck: boolean;
}

export interface ChoreStep {
  process: string;
  parameters: Array<{ name: string; value: string | number }>;
}

export interface ChoreCreate {
  name: string;
  startTime: string;        // ISO 8601, z.B. "2025-01-01T06:00:00"
  dstSensitive: boolean;
  active: boolean;
  executionMode: "SingleCommit" | "MultipleCommit";
  frequency: {
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
  };
  steps: ChoreStep[];
}


export interface ToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

export interface ServerInfo {
  serverName: string;
  productVersion: string;
  productEdition?: string | undefined;
  adminHost?: string | undefined;
  dataDirectory?: string | undefined;
  timeZoneId?: string | undefined;
  integratedSecurityMode?: string | undefined;
  extra: Record<string, unknown>;
}

export interface CompileResult {
  success: boolean;
  errors: Array<{
    lineNumber?: number | undefined;
    procedure?: string | undefined;
    message: string;
  }>;
}

export interface ProcessCheckInput {
  name?: string;
  prolog?: string;
  metadata?: string;
  data?: string;
  epilog?: string;
  parameters?: ProcessParameter[];
  variables?: ProcessVariable[];
  dataSource?: DataSource;
}

export interface CubeView {
  name: string;
  mdx?: string | undefined;
  private: boolean;
}

export interface TransactionLogEntry {
  timestamp: string;
  user: string;
  cubeName: string;
  elements: string[];
  oldValue: CellValue;
  newValue: CellValue;
}

export interface ErrorLogFile {
  filename: string;
  lastUpdated?: string;
}

export interface Subset {
  name: string;
  dimensionName: string;
  hierarchyName: string;
  private: boolean;
  expression?: string | undefined;
  elements: string[];
  alias?: string | undefined;
}

export interface SubsetCreate {
  name: string;
  expression?: string | undefined;
  elements?: string[] | undefined;
  alias?: string | undefined;
}

export interface ElementAttributeValue {
  elementName: string;
  attributeName: string;
  value: CellValue;
}

// Security: Clients and Groups

export interface Client {
  Name: string;
  FriendlyName?: string;
  Type?: string;
  Enabled?: boolean;
  Groups?: { Name: string }[];
}

export interface ClientCreate {
  name: string;
  password?: string | undefined;
  friendlyName?: string | undefined;
  groups?: string[] | undefined;
}

export interface ClientUpdate {
  password?: string | undefined;
  friendlyName?: string | undefined;
  enabled?: boolean | undefined;
}

export interface Group {
  Name: string;
  Clients?: { Name: string }[];
}
