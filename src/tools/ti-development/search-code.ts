import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { TM1Error, TM1ErrorCode } from "../../types.js";
import { maskCodeLine } from "../../lib/mask-secrets.js";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

type Tab = "prolog" | "metadata" | "data" | "epilog";
const ALL_TABS: Tab[] = ["prolog", "metadata", "data", "epilog"];

const COMMENT_RE = /^\s*(?:#|\/\/)/;

interface Match {
  process: string;
  tab: Tab;
  line: number;
  text: string;
  alsoFoundIn?: string[];
}

export function registerSearchCode(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_search_code",
    [
      "Regex search across all TI process code (Prolog/Metadata/Data/Epilog).",
      "Returns matches paginated (default 50/page) with process name, tab, line number, and trimmed line text.",
      "Wrapper over tm1_get_all_processes_code that avoids dumping ~MB of code through the channel.",
      "Use tm1_get_process_code on a hit to inspect the surrounding context.",
    ].join(" "),
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
      deduplicateByLine: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Collapse matches with identical (tab, line-text) across processes into one result. " +
          "The first-seen process is kept; others go into alsoFoundIn[]. " +
          "Drastically reduces output on servers with many process variants. Default: false.",
        ),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
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
      deduplicateByLine,
      limit,
      offset,
      fetchAll,
      format,
    }) => {
      const flags = caseSensitive ? "g" : "gi";
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch (e) {
        throw new TM1Error({
          code: TM1ErrorCode.VALIDATION_ERROR,
          message: `Invalid regex: ${(e as Error).message}`,
          details: pattern,
          hint: "Pattern must be a valid JavaScript regex. Escape backslashes (e.g. 'c:\\\\\\\\' for 'c:\\\\') and balance brackets/parens.",
        });
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
            const raw = lines[i]!;
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

      let deduplicated = false;
      let rawMatchCount: number | undefined;
      if (deduplicateByLine && matches.length > 0) {
        rawMatchCount = matches.length;
        const seen = new Map<string, Match>();
        for (const m of matches) {
          const key = `${m.tab}\x00${m.text}`;
          const existing = seen.get(key);
          if (existing) {
            (existing.alsoFoundIn ??= []).push(m.process);
          } else {
            seen.set(key, { ...m });
          }
        }
        matches.length = 0;
        for (const m of seen.values()) matches.push(m);
        deduplicated = true;
      }

      const page = paginate(matches, limit, offset, fetchAll);
      const wrapper = {
        pattern,
        caseSensitive,
        tabsSearched: searchTabs,
        processesScanned: all.length,
        matchCount: matches.length,
        ...(deduplicated && { rawMatchCount, deduplicated }),
        truncated,
        maskSecrets,
        excludeCommented,
        ...page,
      };
      const columns: Column<Match>[] = [
        { header: "process", get: (m) => m.process },
        { header: "tab", get: (m) => m.tab },
        { header: "line", get: (m) => m.line },
        { header: "text", get: (m) => m.text },
      ];
      return wrappedPageResponse(wrapper, page, format, { title: `Search: ${pattern}`, columns });
    },
  );
}
