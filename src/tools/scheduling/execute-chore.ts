import { z } from "zod";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";
import { DESTRUCTIVE } from "../annotations.js";
import { ChoreResultSchema } from "../schemas/items.js";
import { defineTool } from "../define-tool.js";
import { isOutcomeUnknown, unknownOutcomeHint } from "../error-format.js";

export const registerExecuteChore = defineTool({
  name: "tm1_execute_chore",
  description: [
    "Execute a TM1 chore immediately, bypassing its schedule. Runs synchronously — the call returns when the chore is done, so raise timeoutMs for long chains.",
    "Non-idempotent: runs every chained process. Before: tm1_analyze_chore_graph to preview the call chain.",
    "Chores do NOT stop at a failing step (measured): later steps still run and still commit. Read `outcome`, not `success` alone — `completed_with_errors` means a step failed AND the chore's writes were committed, so re-running duplicates them. A step that aborts commits inside a chore, unlike the same process run on its own.",
    "`rolled_back` (ChoreExecuteStatusCode ProcessRollbackCalled) discards the whole chore so far under ExecutionMode SingleCommit, only the rolling-back step under MultipleCommit.",
    "`statusUnavailable: true` means the server cannot report chore status (v11, and v12 before 12.5.0): the chore ran, the outcome is unknown.",
    "On failure: tm1_diagnose_process_error for the failing step.",
  ],
  annotations: DESTRUCTIVE,
  output: ChoreResultSchema,
  input: {
    choreName: z.string().describe("Chore name (case-sensitive)"),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(3600000)
      .optional()
      .describe(
        "Override the default 30s request timeout for this call (ms, 1000–3600000). Use for chores running long TI chains.",
      ),
    ...CONFIRM_SCHEMA,
  },
  handler: async ({ choreName, timeoutMs, confirm }, tm1Client, extra) => {
    // Runs every chained process; undoing the call does not undo the writes.
    // Guards against accidental invocation — not a security control.
    requireConfirm(confirm, choreName, "chore");
    const result = await tm1Client.chores
      .execute(choreName, {
        signal: extra?.signal,
        ...(timeoutMs ? { timeoutMs } : {}),
      })
      .catch((err: unknown) => {
        if (isOutcomeUnknown(err))
          err.hintOverride = unknownOutcomeHint(tm1Client.version, "chore");
        throw err;
      });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      // Same rule as tm1_execute_process: a chore that ran and reported failure
      // is a tool failure, not a successful call carrying success:false.
      //
      // `statusUnavailable` is the exception and must NOT flag. It also has
      // success:false, but it means "this build cannot report chore status" —
      // on v11 that is EVERY chore run. Flagging it would turn a known API
      // limitation into an error on every single call.
      ...(result.success === false && result.statusUnavailable !== true
        ? { isError: true as const }
        : {}),
    };
  },
});
