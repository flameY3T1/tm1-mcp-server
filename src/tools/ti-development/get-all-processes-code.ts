import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { maskCode } from "../../lib/mask-secrets.js";
import { commentStats } from "../../lib/strip-comments.js";

// Summary mode: drop the four tab bodies, report line metrics instead so
// analysis agents can survey the process landscape without paying full token
// cost (mirrors tm1_get_all_cube_rules summary mode).
function summarize(p: {
  name: string;
  hasSecurityAccess: boolean;
  prolog: string;
  metadata: string;
  data: string;
  epilog: string;
}) {
  const prolog = commentStats(p.prolog);
  const metadata = commentStats(p.metadata);
  const data = commentStats(p.data);
  const epilog = commentStats(p.epilog);
  return {
    name: p.name,
    hasSecurityAccess: p.hasSecurityAccess,
    totalLines: prolog.totalLines + metadata.totalLines + data.totalLines + epilog.totalLines,
    prologLines: prolog.totalLines,
    metadataLines: metadata.totalLines,
    dataLines: data.totalLines,
    epilogLines: epilog.totalLines,
    commentLines: prolog.commentLines + metadata.commentLines + data.commentLines + epilog.commentLines,
  };
}

export function registerGetAllProcessesCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_all_processes_code",
    "Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) for audit. Control objects (names starting with '}') excluded by default. Credential literals in the code are masked by default (maskSecrets). Set summary=true to drop the tab bodies and get per-process line metrics instead. For keyword surveys prefer tm1_search_code — it avoids dumping every process body into context.",
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control processes whose names start with '}' (default: false)"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap the number of returned processes. Omit for full bulk load (audit use-case)."),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals in every returned tab (ODBCOpen passwords, quoted values assigned to credential-named identifiers, conn-string PWD/UID pairs). " +
            "Default: true. Set false only when explicitly auditing credentials.",
        ),
      summary: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Drop the four code tabs, return per-process line metrics instead " +
            "(totalLines, prologLines, metadataLines, dataLines, epilogLines, commentLines) (default: false)",
        ),
    },
    async ({ includeControl, limit, maskSecrets, summary }) => {
      const all = await tm1Client.processes.getAllCode(includeControl);
      const truncated = limit !== undefined && all.length > limit;
      const kept = truncated ? all.slice(0, limit) : all;
      // summary mode returns no code, so masking is moot — skip the work.
      const processes = summary
        ? kept.map(summarize)
        : maskSecrets
          ? kept.map((p) => ({
              ...p,
              prolog: maskCode(p.prolog),
              metadata: maskCode(p.metadata),
              data: maskCode(p.data),
              epilog: maskCode(p.epilog),
            }))
          : kept;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: all.length, returned: processes.length, truncated, processes }) }],
      };
    },
  );
}
