import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
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
    const trimmed = lines[i].trim();
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
    cubeRefs.add(m[1]);
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
      "Use summary=true to replace rulesText with aggregate metrics (lineCount, ruleCount, feederCount, commentLineCount, referencedCubes) — typical 50–100x payload shrink for rules surveys.",
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
    },
    async ({ includeControl, onlyWithRules, summary }) => {
      let all = await tm1Client.getAllCubeRules(includeControl);
      if (onlyWithRules) all = all.filter((c) => c.rulesText.trim().length > 0);
      const cubes = summary
        ? all.map((c) => ({
            cubeName: c.cubeName,
            skipCheck: c.skipCheck,
            ...summarize(c.rulesText),
          }))
        : all;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ count: cubes.length, cubes }, null, 2) }],
      };
    },
  );
}
