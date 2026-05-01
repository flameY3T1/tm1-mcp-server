import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetThreads(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_threads",
    "List all active threads on the TM1 server (running processes, chores, MDX queries, etc.).",
    {},
    async () => {
      try {
        const threads = await tm1Client.getThreads();
        if (threads.length === 0) {
          return { content: [{ type: "text", text: "No active threads." }] };
        }
        const lines = threads.map((t) => {
          const elapsed = t.elapsedTime ? ` | ${t.elapsedTime}` : "";
          const ctx = t.context ? ` | ctx=${t.context}` : "";
          return `ID:${t.id} [${t.type}] ${t.state} | ${t.name} | ${t.objectName} | ${t.function}${ctx}${elapsed}`;
        });
        return { content: [{ type: "text", text: `${threads.length} thread(s):\n${lines.join("\n")}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );

  server.tool(
    "tm1_cancel_thread",
    "Cancel a running TM1 server thread by its ID. Use tm1_list_threads to find the ID.",
    {
      id: z.number().int().describe("Thread ID to cancel"),
    },
    async ({ id }) => {
      try {
        await tm1Client.cancelThread(id);
        return { content: [{ type: "text", text: `Cancel operation sent for thread ${id}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
