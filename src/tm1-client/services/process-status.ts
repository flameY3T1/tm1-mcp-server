// Classification of TM1's `ProcessExecuteStatusCode` — shared by every path
// that runs a TI and has to say what it did: ProcessService.execute,
// ProcessService.saveData and CubeService's 11.x clear-via-TI fallback.
//
// See the `ProcessOutcome` doc in src/types.ts for the measurement table this
// mapping comes from. The short version: the question a caller actually has is
// "was anything committed", and TM1's six status codes answer it in three ways.
import { PROCESS_STATUS_UNKNOWN } from "../../types.js";
import type { ProcessResult } from "../../types.js";

/**
 * Status codes for runs that COMMITTED what they wrote before ending badly.
 * All three measured on 11.8: a marker cell written in the Prolog survived.
 *
 * `CompletedWithMessages` = ItemReject, `QuitCalled` = ProcessQuit.
 * `HasMinorErrors` normally comes from per-record failures in the Metadata/Data
 * tabs and so needs a data source; it was measured here without one, by writing
 * to a consolidated element from the Prolog.
 */
const COMMITTED_STATUSES: ReadonlySet<string> = new Set([
  "HasMinorErrors",
  "QuitCalled",
  "CompletedWithMessages",
]);

/**
 * Status codes for runs whose writes were DISCARDED. Both measured on 11.8:
 * the marker cell was gone afterwards.
 */
const ROLLED_BACK_STATUSES: ReadonlySet<string> = new Set([
  "Aborted",
  "RollbackCalled",
]);

/**
 * Turn TM1's `ProcessExecuteStatusCode` into a `ProcessResult`.
 *
 * Two fail-open readings this closes, and they are mirror images:
 *
 *  1. An ABSENT status code is not success (T-4). The old
 *     `?? "CompletedSuccessfully"` meant a 200 with an empty body, or a body
 *     without the field, reached the caller as a clean run.
 *  2. A present-but-not-`CompletedSuccessfully` code is not a flat failure.
 *     Collapsing all five remaining members into `failed` told a caller that
 *     an `ItemReject`ed run had failed when its writes were already committed —
 *     an invitation to re-run a process that has posted its data once.
 *
 * An UNRECOGNISED code (a seventh member in some future TM1, or a server
 * spelling we have never seen) is `indeterminate`, never a guess: the whole
 * point of the split is that the groups carry measured commit semantics, and
 * an unknown code has none.
 */
export function classifyExecution(
  statusCode: string | undefined,
  errorLogFile: string | undefined,
): ProcessResult {
  if (statusCode === undefined || statusCode === "") {
    return {
      success: false,
      outcome: "indeterminate",
      processErrorStatus: PROCESS_STATUS_UNKNOWN,
      errorLogFile,
    };
  }
  if (statusCode === "CompletedSuccessfully") {
    return {
      success: true,
      outcome: "succeeded",
      processErrorStatus: "CompletedSuccessfully",
      errorLogFile,
    };
  }
  if (COMMITTED_STATUSES.has(statusCode)) {
    return {
      success: false,
      outcome: "completed_with_errors",
      processErrorStatus: statusCode,
      errorLogFile,
    };
  }
  if (ROLLED_BACK_STATUSES.has(statusCode)) {
    return {
      success: false,
      outcome: "rolled_back",
      processErrorStatus: statusCode,
      errorLogFile,
    };
  }
  return {
    success: false,
    outcome: "indeterminate",
    processErrorStatus: `${statusCode}: unrecognised ProcessExecuteStatusCode — this build does not know whether a run ending this way commits its changes. Verify server state (error logs, target cube) before re-running.`,
    errorLogFile,
  };
}
