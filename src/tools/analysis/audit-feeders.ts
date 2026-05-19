import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { parseRules } from "../../lib/callgraph/rulesParser.js";
import { extractBracketLists } from "../../lib/feeders/brackets.js";
import {
  detectBroaderThanRule,
  detectDbFeederWithoutSkipcheck,
  detectFeederToConsolidated,
  detectOrphanFeeder,
  detectWildcardBracket,
} from "../../lib/feeders/static-heuristics.js";
import { ElementTypeCache } from "../../lib/feeders/element-type-cache.js";
import { isControlName } from "../../lib/control-name.js";

type FindingRule =
  | "wildcard_bracket"
  | "feeder_to_consolidated"
  | "feeder_broader_than_rule"
  | "db_feeder_without_skipcheck"
  | "orphan_feeder";

interface Finding {
  cube: string;
  line: number;
  severity: "hint";
  rule: FindingRule;
  feeder: string;
  detail?: string;
}

export function registerAuditFeeders(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_audit_feeders",
    [
      "Bulk-scan cube rules for likely overfeeding patterns (P2: static",
      "heuristics with REST-backed element-type lookups). Detects: wildcard",
      "brackets (S4), feeders targeting consolidated elements (S2), feeders",
      "broader than the cube's dim count (S1), DB() feeders into cubes",
      "without `skipcheck;` (S5), and orphan feeders whose elements appear",
      "in zero rule LHS (S6). Severity is always 'hint' — runtime evidence",
      "(`}StatsByCube` sparsity + memory) lands in a later phase. Control",
      "objects ('}'-prefix) excluded by default.",
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
      s1MinPinnedRatio: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.5)
        .describe(
          "S1 broader-than-rule ratio gate: flag when (feederConstraintCount / cubeTotalDims) < this value. Default 0.5.",
        ),
    },
    async ({ cubes, topN, includeControl, s1MinPinnedRatio }) => {
      const serverInfo = await tm1Client.server.getInfo();
      const all = await tm1Client.cubes.getAllRules(includeControl);
      const targetSet = cubes && cubes.length > 0 ? new Set(cubes) : null;

      // Pre-build skipcheck lookup from every cube's rules AST. Case-folding
      // matches TM1 semantics (cube names compare case-insensitively).
      const skipcheckMap = new Map<string, boolean>();
      for (const c of all) {
        if (!c.rulesText) continue;
        skipcheckMap.set(c.cubeName.toLowerCase(), parseRules(c.rulesText).hasSkipcheck);
      }
      const lookupSkipcheck = (cubeName: string): boolean | null => {
        const v = skipcheckMap.get(cubeName.toLowerCase());
        return v === undefined ? null : v;
      };

      const elementTypeCache = new ElementTypeCache(tm1Client.hierarchies);

      const findings: Finding[] = [];
      let cubesScanned = 0;
      let feederLinesScanned = 0;
      let dimResolveFailures = 0;

      for (const c of all) {
        if (targetSet && !targetSet.has(c.cubeName)) continue;
        if (!includeControl && isControlName(c.cubeName)) continue;
        cubesScanned++;
        if (!c.rulesText || c.rulesText.trim() === "") continue;

        const ast = parseRules(c.rulesText);

        let cubeDimNames: string[] = [];
        try {
          cubeDimNames = await tm1Client.cubes.getDimensionNames(c.cubeName);
        } catch {
          dimResolveFailures++;
        }
        const cubeDimCount = cubeDimNames.length;

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
          // Multi-line feeders put the `=>` and RHS on a continuation line.
          // Treat such continuations as already-covered by the preceding
          // feeder's LHS — skip them so we don't double-count or evaluate
          // an RHS bracket as if it were the LHS.
          if (/^=>/.test(line.trimmed)) continue;
          const lists = extractBracketLists(line.trimmed);
          if (lists.length === 0) continue;
          feederLinesScanned++;
          const feederLhs = lists[0]!;

          let lhsRuleHit: FindingRule | null = null;
          let lhsDetail: string | undefined;

          if (detectWildcardBracket(feederLhs)) {
            lhsRuleHit = "wildcard_bracket";
          } else {
            const cons = await detectFeederToConsolidated(
              feederLhs,
              cubeDimNames,
              elementTypeCache,
            );
            if (cons) {
              lhsRuleHit = "feeder_to_consolidated";
              lhsDetail = `${cons.dim}:${cons.elem}`;
            } else if (detectBroaderThanRule(feederLhs, cubeDimCount, s1MinPinnedRatio)) {
              lhsRuleHit = "feeder_broader_than_rule";
              lhsDetail = `pins ${feederLhs.entries.length}/${cubeDimCount} dims`;
            } else if (detectOrphanFeeder(feederLhs, ruleLhs)) {
              lhsRuleHit = "orphan_feeder";
            }
          }

          if (lhsRuleHit) {
            findings.push({
              cube: c.cubeName,
              line: line.lineIndex + 1,
              severity: "hint",
              rule: lhsRuleHit,
              feeder: line.trimmed,
              ...(lhsDetail !== undefined ? { detail: lhsDetail } : {}),
            });
          }

          const dbTarget = detectDbFeederWithoutSkipcheck(line.trimmed, lookupSkipcheck);
          if (dbTarget) {
            findings.push({
              cube: c.cubeName,
              line: line.lineIndex + 1,
              severity: "hint",
              rule: "db_feeder_without_skipcheck",
              feeder: line.trimmed,
              detail: dbTarget,
            });
          }
        }
      }

      const byRule: Record<FindingRule, number> = {
        wildcard_bracket: 0,
        feeder_to_consolidated: 0,
        feeder_broader_than_rule: 0,
        db_feeder_without_skipcheck: 0,
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
                s1MinPinnedRatio,
                scanned: {
                  cubes: cubesScanned,
                  feederLines: feederLinesScanned,
                  dimResolveFailures,
                },
                invalidCount: findings.length,
                summary: { byRule, byCube },
                truncated: { findings: truncated },
                findings: trimmed,
                rulesetSource:
                  "Static heuristics S1 (feeder_broader_than_rule), S2 (feeder_to_consolidated), " +
                  "S4 (wildcard_bracket), S5 (db_feeder_without_skipcheck), S6 (orphan_feeder). " +
                  "See docs/feeders-audit-spec.md.",
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
