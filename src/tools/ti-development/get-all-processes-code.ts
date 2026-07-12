import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { maskCode } from "../../lib/mask-secrets.js";
export function registerGetAllProcessesCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_all_processes_code",
    "Bulk-load source code (Prolog/Metadata/Data/Epilog) of every TI process in one call, plus each process's HasSecurityAccess elevation flag (hasSecurityAccess) for audit. Control objects (names starting with '}') excluded by default. Credential literals in the code are masked by default (maskSecrets). For keyword surveys prefer tm1_search_code — it avoids dumping every process body into context.",
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
    },
    async ({ includeControl, limit, maskSecrets }) => {
      const all = await tm1Client.processes.getAllCode(includeControl);
      const truncated = limit !== undefined && all.length > limit;
      const kept = truncated ? all.slice(0, limit) : all;
      const processes = maskSecrets
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
