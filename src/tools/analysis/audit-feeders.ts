import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { parseRules } from "../../lib/callgraph/rulesParser.js";
import { extractBracketLists } from "../../lib/feeders/brackets.js";
import {
  detectBroaderThanRule,
  detectOrphanFeeder,
  detectWildcardBracket,
} from "../../lib/feeders/static-heuristics.js";
import { isControlName } from "../../lib/control-name.js";

type FindingRule =
  | "feeder_broader_than_rule"
  | "wildcard_bracket"
  | "orphan_feeder";

interface Finding {
  cube: string;
  line: number;
  severity: "hint";
  rule: FindingRule;
  feeder: string;
}

export function registerAuditFeeders(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_audit_feeders",
    [
      "Bulk-scan cube rules for likely overfeeding patterns (P1 MVP, static",
      "only — no REST element-type lookups yet). Detects: wildcard feeder",
      "brackets (no concrete elements), feeders strictly broader than the",
      "densest rule LHS in the same cube, and orphan feeders whose elements",
      "don't appear in any rule LHS. Severity is always 'hint' at this",
      "stage; runtime evidence (}StatsByCube sparsity + memory) lands in a",
      "later phase. Control objects ('}'-prefix) excluded by default.",
    ].join(" "),
    {
      cubes: z
        .array(z.string())
        .optional()
        .describe(
          "Restrict the scan to these cube names. Default: every non-control cube with rules.",
        ),
      topN: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(50)
        .describe(
          "Cap on returned findings (summary counters reflect the full scan). Default 50.",
        ),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control objects ('}'-prefix). Default false."),
    },
    async ({ cubes, topN, includeControl }) => {
      const serverInfo = await tm1Client.server.getInfo();
      const all = await tm1Client.cubes.getAllRules(includeControl);
      const targetSet = cubes && cubes.length > 0 ? new Set(cubes) : null;

      const findings: Finding[] = [];
      let cubesScanned = 0;
      let feederLinesScanned = 0;

      for (const c of all) {
        if (targetSet && !targetSet.has(c.cubeName)) continue;
        if (!includeControl && isControlName(c.cubeName)) continue;
        cubesScanned++;
        if (!c.rulesText || c.rulesText.trim() === "") continue;

        const ast = parseRules(c.rulesText);

        const ruleLhs = [];
        for (const line of ast.lines) {
          if (line.section !== "rules") continue;
          if (line.isBlank || line.isComment) continue;
          const lists = extractBracketLists(line.trimmed);
          if (lists.length > 0) ruleLhs.push(lists[0]!);
        }

        for (const line of ast.lines) {
          if (line.section !== "feeders") continue;
          if (line.isBlank || line.isComment) continue;
          if (/^feeders\s*;?\s*$/i.test(line.trimmed)) continue;
          const lists = extractBracketLists(line.trimmed);
          if (lists.length === 0) continue;
          feederLinesScanned++;
          const feederLhs = lists[0]!;

          if (detectWildcardBracket(feederLhs)) {
            findings.push({
              cube: c.cubeName,
              line: line.lineIndex + 1,
              severity: "hint",
              rule: "wildcard_bracket",
              feeder: line.trimmed,
            });
            continue;
          }
          if (detectOrphanFeeder(feederLhs, ruleLhs)) {
            findings.push({
              cube: c.cubeName,
              line: line.lineIndex + 1,
              severity: "hint",
              rule: "orphan_feeder",
              feeder: line.trimmed,
            });
            continue;
          }
          if (detectBroaderThanRule(feederLhs, ruleLhs)) {
            findings.push({
              cube: c.cubeName,
              line: line.lineIndex + 1,
              severity: "hint",
              rule: "feeder_broader_than_rule",
              feeder: line.trimmed,
            });
          }
        }
      }

      const byRule: Record<FindingRule, number> = {
        feeder_broader_than_rule: 0,
        wildcard_bracket: 0,
        orphan_feeder: 0,
      };
      const byCube: Record<string, number> = {};
      for (const f of findings) {
        byRule[f.rule]++;
        byCube[f.cube] = (byCube[f.cube] ?? 0) + 1;
      }

      findings.sort(
        (a, b) =>
          a.cube.localeCompare(b.cube) ||
          a.line - b.line ||
          a.rule.localeCompare(b.rule),
      );
      const truncated = findings.length > topN;
      const trimmed = findings.slice(0, topN);

      const status = findings.length > 0 ? "fail" : "pass";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status,
                productVersion: serverInfo.productVersion,
                mode: "static",
                includeControl,
                scanned: {
                  cubes: cubesScanned,
                  feederLines: feederLinesScanned,
                },
                invalidCount: findings.length,
                summary: { byRule, byCube },
                truncated: { findings: truncated },
                findings: trimmed,
                rulesetSource:
                  "Static heuristics S1/S4/S6 — see docs/feeders-audit-spec.md.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
