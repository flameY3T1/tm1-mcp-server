import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerGetSessions(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_list_sessions",
    [
      "List active sessions on the TM1 server with their associated user and threads.",
      "Pair with tm1_list_threads / tm1_cancel_thread to see who is connected and what they are running.",
    ].join(" "),
    {
      activeOnly: z.boolean().optional().default(false)
        .describe("If true, return only sessions flagged Active by the server (default: false — return all)"),
      withThreads: z.boolean().optional().default(true)
        .describe("Include thread details per session (default: true)"),
    },
    async ({ activeOnly, withThreads }) => {
      try {
        const sessions = await tm1Client.getSessions();
        const filtered = activeOnly ? sessions.filter((s) => s.active !== false) : sessions;
        if (filtered.length === 0) {
          return { content: [{ type: "text", text: "No sessions found." }] };
        }
        const lines = filtered.map((s) => {
          const head = `Session ${s.id} | user=${s.user || "(none)"}${s.active !== undefined ? ` | active=${s.active}` : ""} | threads=${s.threads.length}`;
          if (!withThreads || s.threads.length === 0) return head;
          const threadLines = s.threads.map(
            (t) => `  - ID:${t.id} [${t.type}] ${t.state} | ${t.name} | ${t.objectName}${t.objectType ? ` (${t.objectType})` : ""} | ${t.function}${t.elapsedTime ? ` | elapsed=${t.elapsedTime}` : ""}${t.waitTime ? ` | wait=${t.waitTime}` : ""}`,
          );
          return `${head}\n${threadLines.join("\n")}`;
        });
        return { content: [{ type: "text", text: `${filtered.length} session(s):\n${lines.join("\n")}` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
