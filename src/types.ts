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
  readonly httpStatus?: number;
  readonly endpoint?: string;
  readonly details?: string;

  constructor(opts: {
    code: TM1ErrorCode;
    message: string;
    httpStatus?: number;
    endpoint?: string;
    details?: string;
  }) {
    super(opts.message);
    this.name = "TM1Error";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.endpoint = opts.endpoint;
    this.details = opts.details;
  }
}

// ── Domain models ────────────────────────────────────────────────────────────

export interface Cube {
  name: string;
  dimensions: string[];
}

export interface Dimension {
  name: string;
  hierarchies: string[];
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

export interface ViewResult {
  cubeName: string;
  viewName: string;
  cells: Array<{ value: CellValue; formattedValue: string }>;
  axes: MdxAxis[];
}

export interface Process {
  name: string;
  parameters: ProcessParameter[];
}

export interface ProcessParameter {
  name: string;
  type: "String" | "Numeric";
  defaultValue: string | number;
  prompt?: string;
}

export interface ProcessVariable {
  name: string;
  type: "String" | "Numeric";
  position: number;
  startByte?: number;
  endByte?: number;
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
}

export interface ProcessResult {
  success: boolean;
  processErrorStatus: string;
  errorLogFile?: string;
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
  components?: Array<{ name: string; weight: number }>;
}

export interface ElementUpdate {
  newName?: string;
  type?: "Numeric" | "String" | "Consolidated";
  components?: Array<{ name: string; weight: number }>;
}

// ── New domain models (Phase 1) ───────────────────────────────────────────────

export interface Thread {
  id: number;
  type: string;
  name: string;
  state: string;
  function: string;
  objectName: string;
  elapsedTime?: string;
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
  productEdition?: string;
  adminHost?: string;
  dataDirectory?: string;
  timeZoneId?: string;
  integratedSecurityMode?: string;
  extra: Record<string, unknown>;
}

export interface CompileResult {
  success: boolean;
  errors: Array<{
    lineNumber?: number;
    procedure?: string;
    message: string;
  }>;
}

export interface CubeView {
  name: string;
  mdx?: string;
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

export interface Subset {
  name: string;
  dimensionName: string;
  hierarchyName: string;
  private: boolean;
  expression?: string;
  elements: string[];
  alias?: string;
}

export interface SubsetCreate {
  name: string;
  expression?: string;
  elements?: string[];
  alias?: string;
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
  password?: string;
  friendlyName?: string;
  groups?: string[];
}

export interface ClientUpdate {
  password?: string;
  friendlyName?: string;
  enabled?: boolean;
}

export interface Group {
  Name: string;
  Clients?: { Name: string }[];
}
