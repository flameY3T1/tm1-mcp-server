import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { compileUserRegex } from "../../lib/safe-regex.js";
import { FORMAT_SCHEMA, wrappedPageResponse, type Column } from "../format.js";
import { PAGINATION_SCHEMA, paginate } from "../pagination.js";

interface Match {
  cube: string;
  line: number;
  text: string;
  context: string[];
}

export function registerSearchRules(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_search_rules",
    [
      "Regex search across cube rules text.",
      "Returns matches with cube name and line number.",
      "Use tm1_get_cube_rules on a hit to inspect the full rules.",
      "Analogue of tm1_search_code for TI processes.",
    ].join(" "),
    {
      pattern: z
        .string()
        .describe("Regex pattern (JavaScript flavor). Anchors and groups supported."),
      cubes: z
        .array(z.string())
        .optional()
        .describe(
          "Limit search to these cube names (case-sensitive). Default: all cubes.",
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe("Case-sensitive match (default false)"),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control cubes ('}'-prefixed). Default false."),
      includeFeeders: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Include lines after the FEEDERS marker. Set false to restrict to rule lines only.",
        ),
      context: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(0)
        .describe(
          "Lines of surrounding context above and below each match (default 0). Max 10.",
        ),
      maxMatchesPerCube: z
        .number()
        .int()
        .positive()
        .optional()
        .default(50)
        .describe("Cap matches per cube (default 50)"),
      maxTotalMatches: z
        .number()
        .int()
        .positive()
        .optional()
        .default(500)
        .describe("Hard cap on total matches (default 500)"),
      ...PAGINATION_SCHEMA,
      ...FORMAT_SCHEMA,
    },
    async ({
      pattern,
      cubes: cubeFilter,
      caseSensitive,
      includeControl,
      includeFeeders,
      context: ctxLines,
      maxMatchesPerCube,
      maxTotalMatches,
      limit,
      offset,
      fetchAll,
      format,
    }) => {
      const flags = caseSensitive ? "g" : "gi";
      const regex = compileUserRegex(pattern, flags);

      const allRules = await tm1Client.cubes.getAllRules(includeControl);
      const cubeSet =
        cubeFilter && cubeFilter.length > 0 ? new Set(cubeFilter) : null;

      const FEEDERS_RE = /^\s*FEEDERS\s*;?\s*$/i;

      const matches: Match[] = [];
      let truncated = false;
      let cubesScanned = 0;

      outer: for (const cubeRules of allRules) {
        if (cubeSet && !cubeSet.has(cubeRules.cubeName)) continue;
        if (!cubeRules.rulesText) continue;
        cubesScanned++;

        const lines = cubeRules.rulesText.split(/\r?\n/);
        let inFeeders = false;
        let perCube = 0;

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]!;
          if (FEEDERS_RE.test(raw)) inFeeders = true;
          if (inFeeders && !includeFeeders) continue;

          regex.lastIndex = 0;
          if (!regex.test(raw)) continue;

          const ctx: string[] = [];
          if (ctxLines > 0) {
            for (
              let c = Math.max(0, i - ctxLines);
              c <= Math.min(lines.length - 1, i + ctxLines);
              c++
            ) {
              if (c !== i) ctx.push(lines[c]!.trim().slice(0, 200));
            }
          }

          matches.push({
            cube: cubeRules.cubeName,
            line: i + 1,
            text: raw.trim().slice(0, 240),
            context: ctx,
          });
          perCube++;
          if (matches.length >= maxTotalMatches) {
            truncated = true;
            break outer;
          }
          if (perCube >= maxMatchesPerCube) break;
        }
      }

      const page = paginate(matches, limit, offset, fetchAll);
      const wrapper = {
        pattern,
        caseSensitive,
        cubesScanned,
        matchCount: matches.length,
        truncated,
        includeFeeders,
        ...page,
      };
      const columns: Column<Match>[] = [
        { header: "cube", get: (m) => m.cube },
        { header: "line", get: (m) => m.line },
        { header: "text", get: (m) => m.text },
      ];
      return wrappedPageResponse(wrapper, page, format, {
        title: `Rules search: ${pattern}`,
        columns,
      });
    },
  );
}
