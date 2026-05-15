import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { actionResponse } from "../format.js";
import { CONFIRM_SCHEMA, requireConfirm } from "../confirm.js";

export function registerDeleteProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_process",
    [
      "Delete a TurboIntegrator process from the TM1 server.",
      "Irreversible. Safety: pass confirm=<process name verbatim>. Mismatched confirm rejects the call.",
      "Before: tm1_analyze_object_usage to find chores or other processes that reference it; tm1_analyze_chore_graph to confirm no chore depends on it.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to delete"),
      ...CONFIRM_SCHEMA,
    },
    async ({ processName, confirm }) => {
      requireConfirm(confirm, processName, "process");
      await tm1Client.processes.delete(processName);
      return actionResponse({ success: true, processName });
    },
  );
}
