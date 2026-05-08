import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerExecuteChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_execute_chore",
    "Execute a TM1 chore immediately, bypassing its schedule.",
    {
      name: z.string().describe("Chore name (case-sensitive)"),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .optional()
        .describe("Override the default 30s request timeout for this call (ms, 1000–3600000). Use for chores running long TI chains."),
    },
    async ({ name, timeoutMs }) => {
      await tm1Client.chores.execute(name, timeoutMs ? { timeoutMs } : undefined);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, choreName: name }, null, 2),
        }],
      };
    },
  );
}
