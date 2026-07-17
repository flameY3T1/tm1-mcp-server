import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { withToolHint } from "../error-format.js";

/**
 * Client-abort recovery hint, branched by TM1 major version: v11 exposes
 * server threads (tm1_list_threads / tm1_cancel_thread), v12 exposes jobs
 * (tm1_list_jobs / tm1_cancel_job) instead.
 */
export function abortHint(version: 11 | 12): string {
  const monitor = version === 12 ? "tm1_list_jobs" : "tm1_list_threads";
  const cancel = version === 12 ? "tm1_cancel_job" : "tm1_cancel_thread";
  return `Request aborted by the client — the process was NOT confirmed failed and may still be executing. Use ${monitor} to check for it and ${cancel} to stop it. Do NOT blindly re-run: that risks a duplicate execution.`;
}

export function registerExecuteProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_execute_process",
    [
      "Execute a TurboIntegrator process on the TM1 server with optional parameters.",
      "Non-idempotent: each call re-runs the process — do not retry blindly on transport errors without checking server state.",
      "Before: tm1_check_process_code (syntax) and/or tm1_compile_process (full compile). Discover required params with tm1_get_process_parameters.",
      "On failure: use tm1_diagnose_process_error for combined log + cascade fetch.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to execute"),
      parameters: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe("Optional key-value map of process parameters"),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional()
        .describe("Override the default 30s request timeout for this call (ms, 1000–3600000). Use for long-running TI runs."),
    },
    async ({ processName, parameters, timeoutMs }, extra) => {
      // R2-02: TM1 REST exposes no mid-run progress for tm1.Execute, so we
      // emit periodic heartbeat notifications (every 5s) instead. Keeps
      // client UI alive during long TI runs and lets users distinguish
      // "still working" from "hung". Heartbeat-only; total stays undefined
      // since TI duration is unknown ahead of time.
      const progressToken = extra?._meta?.progressToken;
      const start = Date.now();
      let heartbeatTimer: NodeJS.Timeout | undefined;
      if (progressToken !== undefined) {
        const tick = (): void => {
          const elapsedSec = Math.round((Date.now() - start) / 1000);
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: elapsedSec,
                message: `${processName} still running (${elapsedSec}s elapsed)`,
              },
            })
            .catch(() => undefined);
        };
        heartbeatTimer = setInterval(tick, 5000);
      }
      try {
        const result = await withToolHint(
          tm1Client.processes.execute(processName, parameters, { signal: extra?.signal, ...(timeoutMs ? { timeoutMs } : {}) }),
          `Process '${processName}' failed at runtime. Inspect cascade with tm1_diagnose_process_error(processName='${processName}', includeRelated=true). Verify parameter shape via tm1_get_process_parameters; check syntax with tm1_compile_process before re-running.`,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          // A TI process that ran but reported failure is a tool failure, not a
          // successful call carrying success:false. Flag isError so agents that
          // branch on the MCP error signal don't silently treat it as success;
          // the full payload (processErrorStatus, errorLogFile) is preserved by
          // normalizeErrorResult for diagnosis.
          ...(result.success === false ? { isError: true as const } : {}),
        };
      } catch (err) {
        // Client-side cancellation (notifications/cancelled) aborts the fetch,
        // but the TI process keeps running server-side — TM1 REST has no
        // mid-run abort. withToolHint's runtime-failure hint ("diagnose then
        // re-run") is actively wrong here: it invites a duplicate execution.
        // Detect the abort via the MCP signal and point at the live thread.
        if (extra?.signal?.aborted) {
          throw new TM1Error({
            code: TM1ErrorCode.TM1_ERROR,
            message: `Execution of '${processName}' was cancelled client-side before it returned; the TI process may still be running on the TM1 server.`,
            hint: abortHint(tm1Client.version),
          });
        }
        throw err;
      } finally {
        if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      }
    },
  );
}
