import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { commentStats, stripCommentBlocks } from "../../lib/strip-comments.js";
import { maskCode, MASK } from "../../lib/mask-secrets.js";

const TABS = ["prolog", "metadata", "data", "epilog"] as const;
const HEAVY_MIN_LINES = 20;
const HEAVY_RATIO = 0.4;

export function registerGetProcess(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_process",
    "Native full read of a TI process — the read-twin of tm1_upsert_process. Returns the four code " +
      "tabs, parameters, variables, datasource and the HasSecurityAccess elevation flag in one call, " +
      "using the same field names as upsert_process. Field-name parity makes it easy to feed back into " +
      "upsert_process, but the datasource round-trip is lossy for ODBC/ASCII: upsert_process does not " +
      "accept the oDBCConnection/query/usesUnicode fields this read can surface. Every part is behind an " +
      "include-flag (all default true); set a flag false to skip that part's REST call. For git " +
      "persistence use tm1_export_process_to_git instead.",
    {
      processName: z.string().describe("Name of the TI process"),
      includeCode: z.boolean().optional().default(true).describe("Include the four code tabs (default true)."),
      includeParameters: z.boolean().optional().default(true).describe("Include parameters (default true)."),
      includeVariables: z.boolean().optional().default(true).describe("Include variables (default true)."),
      includeDataSource: z.boolean().optional().default(true).describe("Include the datasource config (default true)."),
      includeSecurityAccess: z.boolean().optional().default(true).describe("Include the HasSecurityAccess elevation flag (default true)."),
      maskSecrets: z.boolean().optional().default(true).describe(
        "Redact credential literals in the code tabs (ODBCOpen passwords, credential-named vars). Default true; " +
          "set false only when explicitly auditing credentials. Note: the datasource password is already " +
          "redacted server-side by TM1, so this flag never reveals a real datasource secret.",
      ),
      stripComments: z.boolean().optional().default(false).describe(
        "Collapse runs of 4+ comment lines in the code tabs into a marker (dead-code reduction). Default false.",
      ),
    },
    async ({
      processName,
      includeCode = true,
      includeParameters = true,
      includeVariables = true,
      includeDataSource = true,
      includeSecurityAccess = true,
      maskSecrets = true,
      stripComments = false,
    }) => {
      const payload: Record<string, unknown> = { name: processName };
      let hint: string | undefined;

      if (includeCode) {
        const code = await tm1Client.processes.getCode(processName);
        const tabs: Record<(typeof TABS)[number], string> = {
          prolog: code.prolog,
          metadata: code.metadata,
          data: code.data,
          epilog: code.epilog,
        };

        if (stripComments) {
          let removedLines = 0;
          let collapsedBlocks = 0;
          for (const tab of TABS) {
            const r = stripCommentBlocks(tabs[tab]);
            tabs[tab] = r.code;
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
            const s = commentStats(tabs[tab]);
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

        if (maskSecrets) {
          for (const tab of TABS) tabs[tab] = maskCode(tabs[tab]);
        }
        Object.assign(payload, tabs);
      }

      if (includeParameters) {
        payload.parameters = await tm1Client.processes.getParameters(processName);
      }
      if (includeVariables) {
        payload.variables = await tm1Client.processes.getVariables(processName);
      }
      if (includeDataSource) {
        const ds = await tm1Client.processes.getDataSource(processName);
        if (maskSecrets && ds.password !== undefined && ds.password !== "") {
          ds.password = MASK;
        }
        payload.dataSource = ds;
      }
      if (includeSecurityAccess) {
        payload.hasSecurityAccess = (await tm1Client.processes.getDeployMeta(processName)).hasSecurityAccess;
      }
      if (hint) payload.hint = hint;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );
}
