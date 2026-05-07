import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
const TAB_NAMES = ["prolog", "metadata", "data", "epilog"] as const;
type TabName = (typeof TAB_NAMES)[number];

function byteLen(s: string | undefined): number {
  return s === undefined ? 0 : Buffer.byteLength(s, "utf8");
}

export function registerUpdateProcessCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_update_process_code",
    [
      "Update one or more code tabs of a TI process (partial update supported).",
      "Returns receivedTabs[] + per-tab byte sizes so you can detect silent payload truncation by the MCP transport.",
      "Payload note: MCP stdio JSON-RPC frames are uncapped at protocol level, but very large tabs (>~1 MB) may trip client/server buffer limits — chunked uploads aren't yet supported by this tool. If a tab arrives empty after parse, the server reports the receivedTabs list so the caller can compare against what was sent.",
    ].join(" "),
    {
      processName: z.string().describe("Name of the TI process to update"),
      prolog: z.string().optional().describe("New Prolog tab code"),
      metadata: z.string().optional().describe("New Metadata tab code"),
      data: z.string().optional().describe("New Data tab code"),
      epilog: z.string().optional().describe("New Epilog tab code"),
    },
    async (args) => {
      const { processName, prolog, metadata, data, epilog } = args;
      
      const tabs: Record<TabName, string | undefined> = { prolog, metadata, data, epilog };
      const receivedTabs = TAB_NAMES.filter((t) => tabs[t] !== undefined);
      const tabBytes: Record<string, number> = {};
      for (const t of TAB_NAMES) tabBytes[t] = byteLen(tabs[t]);
      const totalBytes = Object.values(tabBytes).reduce((a, b) => a + b, 0);

      // Log receipt to stderr (stdout is the MCP channel — never write there).
      // Helps diagnose "No code tab provided" when the caller swears they sent one.
      const argKeys = Object.keys(args);
      process.stderr.write(
        `[tm1_update_process_code] processName=${processName} argKeys=[${argKeys.join(",")}] receivedTabs=[${receivedTabs.join(",")}] bytes=${JSON.stringify(tabBytes)} total=${totalBytes}\n`,
      );

      if (receivedTabs.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "No code tab provided. Specify at least one of: prolog, metadata, data, epilog.",
              hint: "If you DID send a tab, your MCP transport may have stripped it. Check argKeys vs. receivedTabs.",
              argKeys,
              receivedTabs,
              tabBytes,
            }),
          }],
          isError: true,
        };
      }

      const code: Record<string, string> = {};
      for (const t of receivedTabs) code[t] = tabs[t]!;

      await tm1Client.updateProcessCode(processName, code);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              updatedTabs: receivedTabs,
              tabBytes,
              totalBytes,
            }),
          },
        ],
      };
    },
  );
}
