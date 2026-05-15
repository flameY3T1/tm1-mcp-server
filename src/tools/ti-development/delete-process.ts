import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
export function registerDeleteProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_delete_process",
    [
      "Delete a TurboIntegrator process from the TM1 server.",
      "Irreversible. Before: tm1_analyze_object_usage to find chores or other processes that reference it; tm1_analyze_chore_graph to confirm no chore depends on it.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to delete"),
    },
    async ({ processName }) => {
      await tm1Client.processes.delete(processName);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ success: true, processName }) }],
      };
    },
  );
}
