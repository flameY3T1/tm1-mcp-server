import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import type { CubeRules } from "../../types.js";

// Default cap for full-rules responses. Whole-model rule dumps flood the
// context window; 50 cubes is plenty for a first look, and the response
// reports truncated=true so agents know to raise limit (or pass 0 for all).
const DEFAULT_LIMIT = 50;

interface CubeRuleSummary {
  lineCount: number;
  ruleCount: number;
  feederCount: number;
  commentLineCount: number;
  referencedCubes: string[];
}

// Best-effort summary parser. TM1 rule grammar is loose; the goal is a useful
// approximation, not perfect parse. Strips block (/* */) and line (#) comments
// before counting, splits on the FEEDERS; section boundary, and extracts cube
// references from DB('Cube', ...) calls.
function summarize(rulesText: string): CubeRuleSummary {
  const lines = rulesText.split(/\r?\n/);
  let commentLineCount = 0;
  let feederBoundary = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#")) commentLineCount++;
    if (feederBoundary < 0 && /^FEEDERS\s*;/i.test(trimmed)) feederBoundary = i;
  }
  const stripBlock = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const stripLine = (s: string) => s.replace(/^[ \t]*#.*$/gm, "");
  const rulesPart =
    feederBoundary >= 0 ? lines.slice(0, feederBoundary).join("\n") : rulesText;
  const feedersPart =
    feederBoundary >= 0 ? lines.slice(feederBoundary + 1).join("\n") : "";
  const cleanRules = stripLine(stripBlock(rulesPart));
  const cleanFeeders = stripLine(stripBlock(feedersPart));
  const ruleCount = (cleanRules.match(/;/g) ?? []).length;
  const feederCount = (cleanFeeders.match(/=>/g) ?? []).length;
  const cubeRefs = new Set<string>();
  for (const m of stripBlock(rulesText).matchAll(/\bDB\s*\(\s*['"]([^'"]+)['"]/gi)) {
    cubeRefs.add(m[1]!);
  }
  return {
    lineCount: lines.length,
    ruleCount,
    feederCount,
    commentLineCount,
    referencedCubes: [...cubeRefs].sort(),
  };
}

export function registerGetAllCubeRules(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_get_all_cube_rules",
    [
      "Bulk-load rules text for every cube in one call.",
      "Cubes without rules are returned with empty rulesText.",
      "Control cubes (names starting with '}') excluded by default.",
      "Full-rules responses are capped at 50 cubes by default (ordered by name; truncated=true when capped — raise limit or pass limit=0 for all).",
      "Use summary=true to replace rulesText with aggregate metrics (lineCount, ruleCount, feederCount, commentLineCount, referencedCubes) — typical 50–100x payload shrink for rules surveys; summary mode surveys ALL cubes by default.",
    ].join(" "),
    {
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include TM1 control cubes whose names start with '}' (default: false)"),
      onlyWithRules: z
        .boolean()
        .optional()
        .default(false)
        .describe("Return only cubes that have non-empty rules text (default: false)"),
      summary: z
        .boolean()
        .optional()
        .default(false)
        .describe("Drop rulesText, return aggregate metrics per cube instead (default: false)"),
      limit: z
        .number()
        .int()
        .min(0)
        .max(500)
        .optional()
        .describe(
          "Max cubes returned (default 50, max 500, 0 = all). Summary mode defaults to 0 (full survey).",
        ),
    },
    async ({ includeControl, onlyWithRules, summary, limit }) => {
      // Full-rules mode default-caps at DEFAULT_LIMIT; summary mode defaults
      // to the whole model (metrics are cheap and a partial survey would be
      // misleading). Explicit limit wins in both modes; 0 = no cap.
      const cap = limit ?? (summary ? 0 : DEFAULT_LIMIT);
      let sliced: CubeRules[];
      let count: number;
      let countIsExact: boolean;
      let truncated: boolean;
      if (cap > 0 && !onlyWithRules) {
        // Server-side cap: $top=cap+1 sentinel detects truncation even if the
        // server omits @odata.count; $orderby=Name keeps the cut stable.
        const { items, total } = await tm1Client.cubes.getAllRules(includeControl, cap + 1);
        truncated = items.length > cap;
        sliced = truncated ? items.slice(0, cap) : items;
        // Truncated without @odata.count only proves "more than cap" — then
        // count is a lower bound, flagged via countIsExact.
        countIsExact = !truncated || total !== undefined;
        count = total ?? items.length;
      } else {
        // onlyWithRules can't be expressed server-side (whitespace-only rules
        // must not count), so that path fetches all and caps client-side —
        // count/truncated then reflect the post-filter set, like before.
        let all = await tm1Client.cubes.getAllRules(includeControl);
        if (onlyWithRules) all = all.filter((c) => c.rulesText.trim().length > 0);
        count = all.length;
        countIsExact = true;
        truncated = cap > 0 && all.length > cap;
        if (truncated) {
          // Match the server-capped path's deterministic name-ordered cut.
          all = [...all].sort((a, b) => a.cubeName.localeCompare(b.cubeName));
        }
        sliced = truncated ? all.slice(0, cap) : all;
      }
      const cubes = summary
        ? sliced.map((c) => ({
            cubeName: c.cubeName,
            skipCheck: c.skipCheck,
            ...summarize(c.rulesText),
          }))
        : sliced;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count, countIsExact, returned: cubes.length, truncated, cubes }) }],
      };
    },
  );
}
