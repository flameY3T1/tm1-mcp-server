// ── Error codes ──────────────────────────────────────────────────────────────

export const TM1ErrorCode = {
  CONNECTION_FAILED: "CONNECTION_FAILED",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
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
  // Set on a timeout of a cancellable request: whether TM1 confirmed the
  // cancel of the server-side operation.
  readonly cancelled?: boolean | undefined;

  constructor(opts: {
    code: TM1ErrorCode;
    message: string;
    httpStatus?: number | undefined;
    endpoint?: string | undefined;
    details?: string | undefined;
    hint?: string | undefined;
    cancelled?: boolean | undefined;
  }) {
    super(opts.message);
    this.name = "TM1Error";
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.endpoint = opts.endpoint;
    this.details = opts.details;
    this.hintOverride = opts.hint;
    this.cancelled = opts.cancelled;
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
    cancelled?: boolean | undefined;
    hint: string;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.httpStatus !== undefined && { httpStatus: this.httpStatus }),
      ...(this.endpoint !== undefined && { endpoint: this.endpoint }),
      ...(this.details !== undefined && { details: this.details }),
      ...(this.cancelled !== undefined && { cancelled: this.cancelled }),
      hint: this.hint,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- accepts known codes + arbitrary strings for extensibility
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
    case TM1ErrorCode.LOCK_TIMEOUT:
      return "Request timed out — TM1 server may be waiting on an exclusive lock held by another session. Use tm1_list_threads to diagnose. Retry after the blocking operation completes.";
    case TM1ErrorCode.TM1_ERROR:
      return "Generic TM1 error. Inspect `details` for the raw server message.";
    default:
      return "Unexpected error. Inspect `message`/`details` and retry with corrected input.";
  }
}

// ── Domain models ────────────────────────────────────────────────────────────

// Shapes whose single definition is the Zod schema in ./schemas/ — the type is
// `z.infer` of it, so a field can only be added or removed in one place. They
// are imported here (other declarations below build on them) and re-exported,
// because every consumer already imports them from this module.
import type {
  AuditLogDetail,
  CellValue,
  Chore,
  Client,
  Cube,
  DataSource,
  Dimension,
  ElementAttributeValue,
  ElementStats,
  ErrorLogFile,
  FedCellDescriptor,
  Group,
  Hierarchy,
  HierarchyElement,
  IgnoredColumn,
  Job,
  JobSession,
  JobWaitingOn,
  MdxAxis,
  MessageLogEntry,
  Process,
  ProcessCode,
  ProcessParameter,
  ProcessVariable,
  Session,
  Subset,
  Thread,
  TransactionLogEntry,
  ViewAxisSubsetRef,
} from "./schemas/index.js";

export type {
  AuditLogDetail,
  CellValue,
  Chore,
  Client,
  Cube,
  DataSource,
  Dimension,
  ElementAttributeValue,
  ElementStats,
  ErrorLogFile,
  FedCellDescriptor,
  Group,
  Hierarchy,
  HierarchyElement,
  IgnoredColumn,
  Job,
  JobSession,
  JobWaitingOn,
  MdxAxis,
  MessageLogEntry,
  Process,
  ProcessCode,
  ProcessParameter,
  ProcessVariable,
  Session,
  Subset,
  Thread,
  TransactionLogEntry,
  ViewAxisSubsetRef,
};

// NOT derived from a Zod schema, on purpose. The similarly-named schemas in
// src/tools/schemas/ describe a DIFFERENT payload, not the same one written
// twice — merging them would force one side to carry the other's fields:
//   MdxResult / ViewResult  the client returns the whole cellset; the tools
//                           publish a paginated envelope (items/offset/has_more)
//                           because a wide view cannot cross the wire whole.
//   CubeRules               the client returns the rule text; the tool schema is
//                           an analysis payload (line/feeder counts, refs).
//   ServerInfo              the tool schema keeps every section `z.unknown()`
//                           and passthrough, since the sections differ per TM1
//                           build; typing it here would be a lie in one place
//                           or the other.
// Anything else belongs in src/schemas/ — see the single-source test in
// tests/unit/schema-single-source.test.ts.
export interface MdxResult {
  cells: Array<{ value: CellValue; formattedValue: string }>;
  axes: MdxAxis[];
  totalCellCount: number;
}

// Feeder / calculation tracing (tm1.CheckFeeders / TraceFeeders /
// TraceCellCalculation, all v11; bound to Cube, keyed by element tuple).

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
  totalCellCount: number;
}

export interface ViewTitleRef extends ViewAxisSubsetRef {
  selectedElement?: string | undefined;
}

export interface NativeViewDefinition {
  titles: ViewTitleRef[];
  columns: ViewAxisSubsetRef[];
  rows: ViewAxisSubsetRef[];
}

/**
 * Axis spec for creating a native view. Exactly one subset source per axis:
 * a registered subset name, an MDX expression, or an explicit element list.
 */
export interface NativeViewAxisSpec {
  dimension: string;
  /** Defaults to the dimension name (same-named hierarchy). */
  hierarchy?: string | undefined;
  subset?: string | undefined;
  expression?: string | undefined;
  elements?: string[] | undefined;
}

export interface NativeViewTitleSpec extends NativeViewAxisSpec {
  /**
   * Title element shown as selected; must be in the subset. Required by TM1 —
   * createNative() rejects title specs without it (optional here only so the
   * validation is reachable).
   */
  selected?: string | undefined;
}

export interface NativeViewCreate {
  columns: NativeViewAxisSpec[];
  rows: NativeViewAxisSpec[];
  titles?: NativeViewTitleSpec[] | undefined;
  suppressEmptyColumns?: boolean | undefined;
  suppressEmptyRows?: boolean | undefined;
  formatString?: string | undefined;
}

export interface ViewDefinition {
  cubeName: string;
  viewName: string;
  private: boolean;
  type: "MDX" | "Native";
  mdx?: string;
  native?: NativeViewDefinition;
}

/**
 * What a TI run is known to have done. The axis that matters to a caller is not
 * "did TM1 like it" but **was anything committed** — TM1's
 * `tm1.ExecuteWithReturn` answers HTTP 200 for every one of these.
 *
 * `ProcessExecuteStatusCode` has exactly six members (read from the `$metadata`
 * of both a v11 11.8 and a v12 12.5.9 server — identical, no version drift):
 * `CompletedSuccessfully`=0, `Aborted`=1, `HasMinorErrors`=2, `QuitCalled`=3,
 * `CompletedWithMessages`=4, `RollbackCalled`=5. They fall into three groups,
 * measured live on 11.8 through `ExecuteWithReturn` by writing a marker cell in
 * the Prolog, taking each exit path, and reading the cell back:
 *
 * - `succeeded`             — `CompletedSuccessfully`. Marker written.
 * - `completed_with_errors` — `CompletedWithMessages` (`ItemReject`),
 *   `QuitCalled` (`ProcessQuit`) and `HasMinorErrors` all left the marker cell
 *   **written**: the process ran and **its changes WERE COMMITTED**. Treat a
 *   blind retry as UNSAFE — the run already wrote data, so re-running can
 *   double-post it. All three are measured; on `HasMinorErrors` note that the
 *   DOCUMENTED path to it is per-record failures in the Metadata/Data tabs,
 *   which need a data source. It was reached here without one, from a pure
 *   Prolog, by writing to a consolidated element — same status code, and the
 *   earlier leaf write committed.
 * - `rolled_back`           — `Aborted` (`ProcessError`, or a `CellPutN` into a
 *   cube that does not exist) and `RollbackCalled` (`ProcessRollback`) both
 *   left the marker cell **rolled back**: the process ran, nothing was
 *   committed. Retrying is safe as far as commit state goes.
 * - `indeterminate`         — no `ProcessExecuteStatusCode` at all, a status
 *   code THIS BUILD DOES NOT KNOW (a seventh member added by a future TM1 must
 *   not be silently absorbed into a group whose commit semantics we never
 *   measured), or a call that errored before any status was reported. The run
 *   may have completed, partially completed, or never started. Defaulting this
 *   to `CompletedSuccessfully` (T-4) reported unverified runs as clean ones.
 *
 * Everything but `succeeded` travels with `success: false`, so the fail-closed
 * `isError` flags on `tm1_execute_process` / `tm1_save_data` keep firing;
 * `outcome` is what tells the three apart.
 */
export type ProcessOutcome =
  "succeeded" | "completed_with_errors" | "rolled_back" | "indeterminate";

/**
 * Result of a TI execution. A discriminated union rather than a flat record so
 * the states the server cannot actually be in are not expressible: before this,
 * `{success: true, processErrorStatus: "Aborted"}` typechecked, and nothing but
 * a code comment kept `success` and the status in agreement.
 *
 * `success` and `outcome` are literal-typed per variant, so they cannot drift
 * apart; either one narrows the union.
 */
export type ProcessResult =
  | {
      success: true;
      outcome: "succeeded";
      /**
       * Pinned: the only status a successful run can carry.
       *
       * NOT a guarantee that the process reached its intended end. `ProcessBreak`
       * also comes back as `CompletedSuccessfully` (verified live on 11.8), so a
       * run that bailed out of its data loop halfway is indistinguishable here.
       * TM1 gives us nothing to detect it with; read this as "TM1 raised no
       * objection and committed", not as "the process did all its work".
       */
      processErrorStatus: "CompletedSuccessfully";
      errorLogFile?: string | undefined;
    }
  | {
      success: false;
      outcome: "completed_with_errors";
      /**
       * TM1's status code: `CompletedWithMessages`, `QuitCalled` or
       * `HasMinorErrors`. **The changes this run made were COMMITTED** — do not
       * retry blindly; check what it already wrote first.
       */
      processErrorStatus: string;
      errorLogFile?: string | undefined;
    }
  | {
      success: false;
      outcome: "rolled_back";
      /** TM1's status code: `Aborted` or `RollbackCalled`. Nothing was committed. */
      processErrorStatus: string;
      errorLogFile?: string | undefined;
    }
  | {
      success: false;
      outcome: "indeterminate";
      /** Says why the outcome is unknown — the only channel for that here. */
      processErrorStatus: string;
      errorLogFile?: string | undefined;
    };

/**
 * Status text used when TM1 answers an execution without a
 * `ProcessExecuteStatusCode`. Carries its own guidance because `ProcessResult`
 * has no hint field and this string is what reaches the model.
 */
export const PROCESS_STATUS_UNKNOWN =
  "Unknown: TM1 returned no ProcessExecuteStatusCode — the run may have completed, partially completed, or never started. Verify server state (error logs, target cube) before re-running.";

/**
 * Outcome of a CHORE run. Deliberately the same four words as
 * `ProcessOutcome`, because the question is the same one — was anything
 * committed — but the mapping behind them is NOT the process mapping and must
 * never be reused across the two. Measured on 12.5.9; see
 * `tm1-client/services/chore-status.ts` for the table.
 *
 * The headline: a step that calls `ProcessError` COMMITS its writes when it
 * runs inside a chore, while the identical process run on its own rolls them
 * back. Anyone who assumes the process semantics carry over gets that backwards.
 */
export type ChoreOutcome =
  "succeeded" | "completed_with_errors" | "rolled_back" | "indeterminate";

/**
 * Result of a chore run. Same discriminated-union shape as `ProcessResult` so
 * neither `success` nor `outcome` can drift from the status.
 *
 * `statusUnavailable` is the one field with no `ProcessResult` counterpart: on
 * a server without `tm1.ExecuteWithReturn` on Chore (v11 entirely, and v12
 * before 12.5.0) the chore still RUNS, but the API reports nothing back. That
 * is not a failure and not a success — it is the absence of an answer, and it
 * has to be distinguishable from both.
 */
export type ChoreResult =
  | {
      success: true;
      outcome: "succeeded";
      /** Pinned: the only status a clean chore run carries. */
      choreErrorStatus: "CompletedSuccessfully";
      /**
       * Always present on v12 — a chore writes a `ChoreLog_*.jsonl` even when
       * nothing went wrong, so unlike a process's error log its PRESENCE says
       * nothing about the outcome. Read the status, not this field.
       */
      errorLogFile?: string | undefined;
      statusUnavailable?: false | undefined;
    }
  | {
      success: false;
      outcome: "completed_with_errors";
      /**
       * TM1's status code, in practice `CompletedWithMessages`. **The chore's
       * writes were COMMITTED, including those of the step that failed** —
       * measured, and the opposite of what the same TI does standalone. Do not
       * re-run blindly.
       */
      choreErrorStatus: string;
      errorLogFile?: string | undefined;
      statusUnavailable?: false | undefined;
    }
  | {
      success: false;
      outcome: "rolled_back";
      /**
       * TM1's status code, in practice `ProcessRollbackCalled`. HOW MUCH was
       * discarded depends on the chore's `ExecutionMode`: `SingleCommit`
       * discards everything the chore had written up to that point,
       * `MultipleCommit` only the rolling-back step. Later steps still run and
       * still commit under both.
       */
      choreErrorStatus: string;
      errorLogFile?: string | undefined;
      statusUnavailable?: false | undefined;
    }
  | {
      success: false;
      outcome: "indeterminate";
      /** Says why the outcome is unknown — the only channel for that here. */
      choreErrorStatus: string;
      errorLogFile?: string | undefined;
      /**
       * true = this server cannot report chore status at all (no
       * `tm1.ExecuteWithReturn` on Chore). The chore ran; nothing is known
       * about how it ended. Distinct from "ran and the answer was unreadable".
       */
      statusUnavailable?: boolean | undefined;
    };

/**
 * Status text for a chore that ran on a server which cannot report back.
 */
export const CHORE_STATUS_UNAVAILABLE =
  "Unknown: this TM1 build has no tm1.ExecuteWithReturn on Chore (v11, and v12 before 12.5.0), so the chore was started and no status was returned. It may have completed, partially completed, or failed. Check the chore's steps with tm1_get_message_log (v11) or the target cubes before re-running.";

/**
 * Status text used when a server that DOES support the action answers without
 * a `ChoreExecuteStatusCode`.
 */
export const CHORE_STATUS_UNKNOWN =
  "Unknown: TM1 returned no ChoreExecuteStatusCode — the chore may have completed, partially completed, or never started. Verify server state before re-running.";

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

export interface RuleSyntaxError {
  message: string;
  lineNumber?: number;
}

/** One /AuditLogEntries row; details present only when expanded. */
export interface AuditLogEntry extends AuditLogDetail {
  details?: AuditLogDetail[] | undefined;
}

export interface CubeRules {
  cubeName: string;
  rulesText: string;
  skipCheck: boolean;
  /**
   * Ordered dimension names. Only present when the rules were fetched with
   * `withDimensions` — otherwise the caller never asked and the server never
   * expanded them.
   */
  dimensions?: string[];
}

export interface ChoreStep {
  process: string;
  parameters: Array<{ name: string; value: string | number }>;
}

export interface ChoreCreate {
  name: string;
  startTime: string; // ISO 8601, z.B. "2025-01-01T06:00:00"
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

export interface TransactionLogResult {
  entries: TransactionLogEntry[];
  /** partial = stopped because `top` filled (older rows may exist); complete = span exhausted. */
  coverage: "complete" | "partial";
  /** Earliest timestamp actually scanned (floor of the walk / the `since` bound). */
  scannedFrom: string;
}

export interface SubsetCreate {
  name: string;
  expression?: string | undefined;
  elements?: string[] | undefined;
  alias?: string | undefined;
}

// Security: Clients and Groups

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
