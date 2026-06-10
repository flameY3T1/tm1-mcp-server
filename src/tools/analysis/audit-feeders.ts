import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { parseRules } from "../../lib/callgraph/rulesParser.js";
import { extractBracketLists } from "../../lib/feeders/brackets.js";
import {
  detectBroaderThanMatchedRule,
  detectBroaderThanRule,
  detectDbFeederWithoutSkipcheck,
  detectFeederToConsolidated,
  detectMissingConditionalFeeder,
  detectOrphanFeeder,
  detectWildcardBracket,
  findMatchingRule,
} from "../../lib/feeders/static-heuristics.js";
import { ElementTypeCache } from "../../lib/feeders/element-type-cache.js";
import {
  computeSparsity,
  fetchCubeStats,
  type CubeStatsItem,
} from "../../lib/cube-stats/fetcher.js";
import { isControlName } from "../../lib/control-name.js";

type FindingRule =
  | "wildcard_bracket"
  | "feeder_to_consolidated"
  | "feeder_broader_than_rule"
  | "missing_conditional_feeder"
  | "db_feeder_without_skipcheck"
  | "orphan_feeder"
  | "cube_low_sparsity"
  | "cube_high_memory";

type Severity = "hint" | "evidence";

interface Finding {
  cube: string;
  line: number;
  severity: Severity;
  rule: FindingRule;
  feeder: string;
  detail?: string;
}

interface RuntimeStats {
  available: boolean;
  memoryTotal: number | null;
  memoryMb: number | null;
  fedCells: number | null;
  populatedNumeric: number | null;
  sparsity: number | null;
  error?: string;
}

export function registerAuditFeeders(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_audit_feeders",
    "Static heuristics (S1–S6) scan cube rules for overfeeding: wildcard brackets, feeders into consolidated " +
    "elements, over-broad feeders, unguarded STET/IF feeders, DB() without skipcheck, orphan feeders. " +
    "mode='runtime' returns StatsByCube sparsity/memory stats; mode='both' runs both and escalates static findings with runtime evidence.",
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
          "S1 ratio-fallback gate (only used when no rule shares any element with the feeder.RHS): flag when (feederConstraintCount / cubeTotalDims) < this value. Default 0.5. Rule-paired comparison (feeder.pinned < matchedRule.pinned) is preferred when a match is found.",
        ),
      mode: z
        .enum(["static", "runtime", "both"])
        .optional()
        .default("static")
        .describe(
          "static: rule-text heuristics only (default). runtime: }StatsByCube cube-level findings only (no static scan). both: static scan + runtime evidence + severity escalation on overlap.",
        ),
      sparsityThreshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.10)
        .describe(
          "Runtime: flag cube when populatedNumeric / fedCells < this value. Default 0.10 (under 10 % of fed cells carry data — typical factor-10x overfeeding threshold). Lower (e.g. 0.01) for stricter audits that only flag extreme cases; raise (e.g. 0.20) to catch milder overfeeding.",
        ),
      memoryThresholdMb: z
        .number()
        .min(0)
        .optional()
        .default(1024)
        .describe(
          "Runtime: flag cube when memoryTotal (MB) ≥ this value. Default 1024 (1 GiB).",
        ),
      severityThreshold: z
        .enum(["none", "hint", "evidence"])
        .optional()
        .default("hint")
        .describe(
          "pass/fail boundary on `status`. none: always pass. hint (default): fail on any finding. evidence: fail only when runtime evidence is present — useful for CI gates that should not block on static-only hints.",
        ),
    },
    async ({
      cubes,
      topN,
      includeControl,
      s1MinPinnedRatio,
      mode,
      sparsityThreshold,
      memoryThresholdMb,
      severityThreshold,
    }) => {
      const serverInfo = await tm1Client.server.getInfo();
      const all = await tm1Client.cubes.getAllRules(includeControl);
      const targetSet = cubes && cubes.length > 0 ? new Set(cubes) : null;

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
      const scannedCubeNames: string[] = [];
      let cubesScanned = 0;
      let feederLinesScanned = 0;
      let dimResolveFailures = 0;
      const wantsStatic = mode === "static" || mode === "both";

      for (const c of all) {
        if (targetSet && !targetSet.has(c.cubeName)) continue;
        if (!includeControl && isControlName(c.cubeName)) continue;
        cubesScanned++;
        scannedCubeNames.push(c.cubeName);
        if (!c.rulesText || c.rulesText.trim() === "") continue;
        if (!wantsStatic) continue;

        const ast = parseRules(c.rulesText);

        let cubeDimNames: string[] = [];
        try {
          cubeDimNames = await tm1Client.cubes.getDimensionNames(c.cubeName);
        } catch {
          dimResolveFailures++;
        }
        const cubeDimCount = cubeDimNames.length;

        const ruleLhs = [];
        const conditionalRuleLhs = [];
        for (const line of ast.lines) {
          if (line.section !== "rules") continue;
          if (line.isBlank || line.isComment) continue;
          const lists = extractBracketLists(line.trimmed);
          if (lists.length === 0) continue;
          ruleLhs.push(lists[0]!);
          if (line.hasStet || line.hasIfGuard) {
            conditionalRuleLhs.push(lists[0]!);
          }
        }

        for (const line of ast.lines) {
          if (line.section !== "feeders") continue;
          if (line.isBlank || line.isComment) continue;
          if (/^feeders\s*;?\s*$/i.test(line.trimmed)) continue;
          // Multi-line feeders place `=>` and the RHS on a continuation line.
          // The preceding feeder's LHS already covered it — skip so we don't
          // re-score the RHS bracket as if it were the LHS.
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
            } else if (!isCrossCubeDbFeeder(line.trimmed)) {
              // Cross-cube DB-feeders: rule lives in target cube; S5 covers
              // their DB-feeder risk so skip S1 here.
              // Pair by feeder.RHS ⇄ rule.LHS — the feeder marks cells the
              // rule writes, so the target bracket is the right signal.
              // Falls back to feeder.LHS when RHS isn't a plain bracket.
              const feederRhs = lists.length > 1 ? lists[1]! : null;
              const matchBracket = feederRhs ?? feederLhs;
              const matchedRule = findMatchingRule(matchBracket, ruleLhs);
              if (matchedRule) {
                if (detectBroaderThanMatchedRule(feederLhs, matchedRule)) {
                  lhsRuleHit = "feeder_broader_than_rule";
                  lhsDetail = `pins ${feederLhs.entries.length} vs rule ${matchedRule.entries.length}`;
                }
              } else if (detectBroaderThanRule(feederLhs, cubeDimCount, s1MinPinnedRatio)) {
                lhsRuleHit = "feeder_broader_than_rule";
                lhsDetail = `pins ${feederLhs.entries.length}/${cubeDimCount} dims (no matching rule — ratio fallback)`;
              }
            }
            if (!lhsRuleHit) {
              if (
                detectMissingConditionalFeeder(
                  feederLhs,
                  line.hasIfGuard,
                  conditionalRuleLhs,
                )
              ) {
                lhsRuleHit = "missing_conditional_feeder";
              } else if (!isCrossCubeDbFeeder(line.trimmed)) {
                // Cross-cube DB-feeders: target rules live in another cube,
                // so a local orphan check can't see them. S5 covers the
                // DB-skipcheck risk; skip S6 here to avoid false orphans.
                // Orphan check uses feeder.RHS (target cells) so it pairs
                // with rule.LHS (cells the rule writes) — feeder.LHS uses
                // different elements in the idiomatic 1:1 pattern.
                const feederRhs = lists.length > 1 ? lists[1]! : null;
                const orphanBracket = feederRhs ?? feederLhs;
                if (detectOrphanFeeder(orphanBracket, ruleLhs)) {
                  lhsRuleHit = "orphan_feeder";
                }
              }
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

      // ─── Runtime evidence (mode: runtime | both) ────────────────────────
      const wantsRuntime = mode === "runtime" || mode === "both";
      const runtimeStats: Record<string, RuntimeStats> = {};
      let runtimeAvailableCount = 0;
      let runtimeFailureCount = 0;

      if (wantsRuntime && scannedCubeNames.length > 0) {
        const settled = await Promise.allSettled(
          scannedCubeNames.map((name) => fetchCubeStats(tm1Client, name)),
        );
        for (let i = 0; i < settled.length; i++) {
          const cubeName = scannedCubeNames[i]!;
          const r = settled[i]!;
          if (r.status !== "fulfilled") {
            runtimeFailureCount++;
            runtimeStats[cubeName] = {
              available: false,
              memoryTotal: null,
              memoryMb: null,
              fedCells: null,
              populatedNumeric: null,
              sparsity: null,
              error: String(r.reason),
            };
            continue;
          }
          const stats: CubeStatsItem = r.value;
          const memoryTotal =
            typeof stats.memoryTotal === "number" ? stats.memoryTotal : null;
          const memoryMb =
            memoryTotal !== null ? Number((memoryTotal / 1_048_576).toFixed(2)) : null;
          const fedCells = typeof stats.fedCells === "number" ? stats.fedCells : null;
          const populatedNumeric =
            typeof stats.populatedNumeric === "number" ? stats.populatedNumeric : null;
          const sparsity = computeSparsity(stats);
          const stat: RuntimeStats = {
            available: true,
            memoryTotal,
            memoryMb,
            fedCells,
            populatedNumeric,
            sparsity,
          };
          runtimeStats[cubeName] = stat;
          runtimeAvailableCount++;

          // Cube-level findings (severity: evidence).
          if (sparsity !== null && sparsity < sparsityThreshold) {
            findings.push({
              cube: cubeName,
              line: 0,
              severity: "evidence",
              rule: "cube_low_sparsity",
              feeder: "",
              detail: `sparsity=${sparsity.toFixed(4)} (populated ${populatedNumeric ?? "?"} / fed ${fedCells ?? "?"})`,
            });
          }
          if (memoryMb !== null && memoryMb >= memoryThresholdMb) {
            findings.push({
              cube: cubeName,
              line: 0,
              severity: "evidence",
              rule: "cube_high_memory",
              feeder: "",
              detail: `${memoryMb} MB`,
            });
          }
        }

        // Escalate static findings on cubes with runtime evidence.
        const evidenceCubes = new Set<string>();
        for (const f of findings) {
          if (
            f.severity === "evidence" &&
            (f.rule === "cube_low_sparsity" || f.rule === "cube_high_memory")
          ) {
            evidenceCubes.add(f.cube);
          }
        }
        for (const f of findings) {
          if (f.severity === "hint" && evidenceCubes.has(f.cube)) {
            f.severity = "evidence";
          }
        }
      }

      const byRule: Record<FindingRule, number> = {
        wildcard_bracket: 0,
        feeder_to_consolidated: 0,
        feeder_broader_than_rule: 0,
        missing_conditional_feeder: 0,
        db_feeder_without_skipcheck: 0,
        orphan_feeder: 0,
        cube_low_sparsity: 0,
        cube_high_memory: 0,
      };
      const bySeverity: Record<Severity, number> = { hint: 0, evidence: 0 };
      const byCube: Record<string, number> = {};
      for (const f of findings) {
        byRule[f.rule]++;
        bySeverity[f.severity]++;
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

      let status: "pass" | "fail";
      if (severityThreshold === "none") {
        status = "pass";
      } else if (severityThreshold === "evidence") {
        status = bySeverity.evidence > 0 ? "fail" : "pass";
      } else {
        status = findings.length > 0 ? "fail" : "pass";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status,
                productVersion: serverInfo.productVersion,
                mode,
                includeControl,
                s1MinPinnedRatio,
                sparsityThreshold,
                memoryThresholdMb,
                severityThreshold,
                scanned: {
                  cubes: cubesScanned,
                  feederLines: feederLinesScanned,
                  dimResolveFailures,
                  runtimeAvailable: runtimeAvailableCount,
                  runtimeFailures: runtimeFailureCount,
                },
                invalidCount: findings.length,
                summary: { byRule, bySeverity, byCube },
                truncated: { findings: truncated },
                findings: trimmed,
                runtimeStats: wantsRuntime ? runtimeStats : undefined,
                rulesetSource:
                  "Static heuristics S1 (feeder_broader_than_rule), S2 (feeder_to_consolidated), " +
                  "S3 (missing_conditional_feeder), S4 (wildcard_bracket), " +
                  "S5 (db_feeder_without_skipcheck), S6 (orphan_feeder). " +
                  "Runtime evidence: cube_low_sparsity + cube_high_memory via }StatsByCube. " +
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

/**
 * Cross-cube DB-feeder: the feeder line writes into another cube via DB(...).
 * Static-scan can't pair these with a local rule because the rule lives in
 * the *target* cube, not the source. S5 (db_feeder_without_skipcheck) already
 * covers their DB-feeder risk profile, so S1 skips them.
 */
function isCrossCubeDbFeeder(lineText: string): boolean {
  return /=>\s*DB\s*\(/i.test(lineText);
}
