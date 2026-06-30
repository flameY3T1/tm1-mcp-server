import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { commentStats, stripCommentBlocks } from "../../lib/strip-comments.js";

// A tab counts as comment-heavy (worth flagging for stripComments) only when it
// is both long enough to matter and mostly comments.
const HEAVY_MIN_LINES = 20;
const HEAVY_RATIO = 0.4;

const TABS = ["prolog", "metadata", "data", "epilog"] as const;

export function registerGetProcessCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process_code",
    "Get the source code of all four tabs (Prolog, Metadata, Data, Epilog) of a TI process. " +
      "Grown TM1 models often carry large blocks of commented-out dead code; set stripComments=true " +
      "to collapse runs of 4+ comment lines into a `# [... N lines ...]` marker and save context.",
    {
      processName: z.string().describe("Name of the TI process"),
      stripComments: z.boolean().optional().default(false).describe(
        "If true, collapse blocks of 4+ consecutive comment lines into a single marker (dead-code reduction). " +
          "Inline and short comments are kept. Default false (full verbatim source).",
      ),
    },
    async ({ processName, stripComments }) => {
      const code = await tm1Client.processes.getCode(processName);
      let hint: string | undefined;

      if (stripComments) {
        let removedLines = 0;
        let collapsedBlocks = 0;
        for (const tab of TABS) {
          const r = stripCommentBlocks(code[tab]);
          code[tab] = r.code;
          removedLines += r.removedLines;
          collapsedBlocks += r.collapsedBlocks;
        }
        if (collapsedBlocks > 0) {
          hint = `stripComments collapsed ${collapsedBlocks} comment block(s) (${removedLines} lines) into markers. ` +
            `Re-run without stripComments for the full source.`;
        }
      } else {
        let worst: { tab: string; total: number; comment: number; ratio: number } | undefined;
        for (const tab of TABS) {
          const s = commentStats(code[tab]);
          if (s.totalLines < HEAVY_MIN_LINES) continue;
          const ratio = s.commentLines / s.totalLines;
          if (ratio >= HEAVY_RATIO && (!worst || ratio > worst.ratio)) {
            worst = { tab, total: s.totalLines, comment: s.commentLines, ratio };
          }
        }
        if (worst) {
          const pct = Math.round(worst.ratio * 100);
          hint = `${worst.tab} tab is ${pct}% comments (${worst.comment}/${worst.total} lines). ` +
            `Set stripComments=true to collapse dead-code blocks and save context.`;
        }
      }

      const payload = { ...code, ...(hint ? { hint } : {}) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
