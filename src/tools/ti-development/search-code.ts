import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error } from "../../types.js";
import { maskCodeLine } from "../../lib/mask-secrets.js";

type Tab = "prolog" | "metadata" | "data" | "epilog";
const ALL_TABS: Tab[] = ["prolog", "metadata", "data", "epilog"];

const COMMENT_RE = /^\s*(?:#|\/\/)/;

interface Match {
  process: string;
  tab: Tab;
  line: number;
  text: string;
}

export function registerSearchCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_search_code",
    "Regex search across all TI process code (Prolog/Metadata/Data/Epilog). Returns matches with process name, tab, line number, and trimmed line text. Wrapper over tm1_get_all_processes_code that avoids dumping ~MB of code through the channel.",
    {
      pattern: z.string().describe("Regex pattern (JavaScript flavor). Anchors and groups supported."),
      tabs: z
        .array(z.enum(["prolog", "metadata", "data", "epilog"]))
        .optional()
        .describe("Tabs to search (default: all four)"),
      caseSensitive: z.boolean().optional().default(false).describe("Case-sensitive match (default false)"),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control processes ('}'-prefixed). Default false."),
      maxMatchesPerProcess: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Cap matches per process to avoid runaway output (default 20)"),
      maxTotalMatches: z
        .number()
        .int()
        .positive()
        .optional()
        .default(500)
        .describe("Hard cap on total matches across all processes (default 500)"),
      maskSecrets: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Redact credential literals in match text. Masks the password arg of ODBCOpen() and quoted values assigned to credential-named identifiers (pPwd, sToken, …). Default: true. Set false only when explicitly auditing credentials.",
        ),
      excludeCommented: z
        .boolean()
        .optional()
        .default(false)
        .describe("Skip lines beginning with '#' or '//' (TI comment markers). Default: false."),
    },
    async ({
      pattern,
      tabs,
      caseSensitive,
      includeControl,
      maxMatchesPerProcess,
      maxTotalMatches,
      maskSecrets,
      excludeCommented,
    }) => {
      try {
        const flags = caseSensitive ? "g" : "gi";
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, flags);
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Invalid regex: ${(e as Error).message}` }) }],
            isError: true,
          };
        }

        const searchTabs = tabs && tabs.length > 0 ? tabs : ALL_TABS;
        const all = await tm1Client.processes.getAllCode(includeControl);

        const matches: Match[] = [];
        let truncated = false;

        outer: for (const proc of all) {
          let perProcess = 0;
          for (const tab of searchTabs) {
            const code = (proc as Record<Tab, string>)[tab] ?? "";
            if (!code) continue;
            const lines = code.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              regex.lastIndex = 0;
              const raw = lines[i];
              if (excludeCommented && COMMENT_RE.test(raw)) continue;
              if (regex.test(raw)) {
                const text = (maskSecrets ? maskCodeLine(raw) : raw).trim().slice(0, 240);
                matches.push({ process: proc.name, tab, line: i + 1, text });
                perProcess++;
                if (matches.length >= maxTotalMatches) {
                  truncated = true;
                  break outer;
                }
                if (perProcess >= maxMatchesPerProcess) break;
              }
            }
            if (perProcess >= maxMatchesPerProcess) break;
          }
        }

        const summary = {
          pattern,
          caseSensitive,
          tabsSearched: searchTabs,
          processesScanned: all.length,
          matchCount: matches.length,
          truncated,
          maskSecrets,
          excludeCommented,
          matches,
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
      } catch (error) {
        const msg =
          error instanceof TM1Error
            ? { code: error.code, message: error.message, httpStatus: error.httpStatus, endpoint: error.endpoint }
            : { error: String(error) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(msg) }],
          isError: true,
        };
      }
    },
  );
}
