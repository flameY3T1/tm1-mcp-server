import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { maskCode } from "../../lib/mask-secrets.js";
import { commentStats } from "../../lib/strip-comments.js";

// Default cap for full-code responses. Whole-model code dumps flood the
// context window; 50 processes is plenty for a first look, and the response
// reports truncated=true so agents know to raise limit (or pass 0 for all).
const DEFAULT_LIMIT = 50;

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
    "Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) for audit. Control objects (names starting with '}') excluded by default. Credential literals in the code are masked by default (maskSecrets). Full-code responses are capped at 50 processes by default (ordered by name; truncated=true when capped — raise limit or pass limit=0 for all). Set summary=true to drop the tab bodies and get per-process line metrics instead; summary mode surveys ALL processes by default. For keyword surveys prefer tm1_search_code — it avoids dumping every process body into context.",
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control processes whose names start with '}' (default: false)"),
      limit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .optional()
        .describe(
          "Max processes returned (default 50, max 500, 0 = all). Summary mode defaults to 0 (full survey).",
        ),
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
      // Full-code mode default-caps at DEFAULT_LIMIT; summary mode defaults to
      // the whole model (metrics are cheap and a partial survey would be
      // misleading). Explicit limit wins in both modes; 0 = no cap.
      const cap = limit ?? (summary ? 0 : DEFAULT_LIMIT);
      // Server-side cap: $top=cap+1 sentinel detects truncation even if the
      // server omits @odata.count; $orderby=Name keeps the cut stable.
      const fetched =
        cap > 0
          ? await tm1Client.processes.getAllCode(includeControl, cap + 1)
          : { items: await tm1Client.processes.getAllCode(includeControl), total: undefined };
      const truncated = cap > 0 && fetched.items.length > cap;
      const kept = truncated ? fetched.items.slice(0, cap) : fetched.items;
      // An uncapped fetch saw everything and @odata.count is authoritative,
      // but a truncated capped fetch without @odata.count only proves "more
      // than cap" — then count is a lower bound, flagged via countIsExact.
      const countIsExact = !truncated || fetched.total !== undefined;
      const count = fetched.total ?? fetched.items.length;
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
        content: [{ type: "text" as const, text: JSON.stringify({ count, countIsExact, returned: processes.length, truncated, processes }) }],
      };
    },
  );
}
