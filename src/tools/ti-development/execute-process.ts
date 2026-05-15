import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { withToolHint } from "../error-format.js";

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
    async ({ processName, parameters, timeoutMs }) => {
      const result = await withToolHint(
        tm1Client.processes.execute(processName, parameters, timeoutMs ? { timeoutMs } : undefined),
        `Process '${processName}' failed at runtime. Inspect cascade with tm1_diagnose_process_error(processName='${processName}', includeRelated=true). Verify parameter shape via tm1_get_process_parameters; check syntax with tm1_compile_process before re-running.`,
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
