import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import {
  computeProcessMetrics,
  type ProcessMetrics,
} from "../../lib/complexity/process-metrics.js";
import {
  computeRulesMetrics,
  type RulesMetrics,
} from "../../lib/complexity/rules-metrics.js";
import {
  clusterVariableNames,
  findTypeInconsistencies,
  reportPrefixConvention,
  groupByCohort,
  type ProcessVarInput,
} from "../../lib/complexity/cross-process.js";
const SCOPE_VALUES = ["processes", "rules", "consistency"] as const;
type Scope = (typeof SCOPE_VALUES)[number];

const SCOPE_DEFAULT: ReadonlyArray<Scope> = ["processes", "rules", "consistency"];

export function registerAuditComplexity(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_audit_complexity",
    [
      "Bulk-scan TI processes and cube rules for complexity + cross-process",
      "consistency. Per process: LOC per tab, branches, max nesting, comment",
      "ratio, score (loc + 2*branches + 3*nesting). Per cube rules: LOC, rule",
      "and feeder counts, DB() coupling and target cubes, skipcheck/feedstrings",
      "flags, comment ratio. Consistency: variable-name variant clusters",
      "(pYear/vYear/Year), type conflicts (same name different type across",
      "processes), prefix-convention adherence (p/v/n/s), and cohorts grouped",
      "by trailing name token. Control objects ('}'-prefix) excluded by default.",
    ].join(" "),
    {
      scope: z
        .array(z.enum(SCOPE_VALUES))
        .optional()
        .describe(
          "Sections to scan: 'processes' (TI metrics), 'rules' (cube rules), " +
            "'consistency' (cross-process naming/type/cohort checks). Default: all three.",
        ),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control objects ('}'-prefix). Default false."),
      topN: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe(
          "Per section, return only the N highest-scoring entries. Summary " +
            "counters reflect the full scan. Default 20.",
        ),
      scoreThreshold: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe(
          "Filter: only include entries whose score is >= this value (applied " +
            "alongside topN). Default 0 (no filter). When > 0, surviving " +
            "process/rules entries also drive status='fail'; at 0, status is " +
            "informational and only consistency issues (variable clusters, " +
            "type conflicts) trigger 'fail'.",
        ),
    },
    async ({ scope, includeControl, topN, scoreThreshold }) => {
      const activeScope: ReadonlyArray<Scope> =
        scope && scope.length > 0 ? scope : SCOPE_DEFAULT;
      const want = (s: Scope) => activeScope.includes(s);

      const serverInfo = await tm1Client.server.getInfo();

      const processMetrics: ProcessMetrics[] = [];
      const processVarInputs: ProcessVarInput[] = [];

      // ── Processes ──────────────────────────────────────────────────────
      // getAllCode / getAllRules apply the control-prefix filter server-side
      // via OData ($filter=not startswith(Name,'}')), so we trust the service
      // and don't double-filter here.
      if (want("processes") || want("consistency")) {
        const all = await tm1Client.processes.getAllCode(includeControl);
        for (const p of all) {
          processMetrics.push(
            computeProcessMetrics(p.name, {
              prolog: p.prolog,
              metadata: p.metadata,
              data: p.data,
              epilog: p.epilog,
            }),
          );
        }
        if (want("consistency")) {
          for (const p of all) {
            const vars = await tm1Client.processes.getVariables(p.name);
            processVarInputs.push({
              process: p.name,
              variables: vars.map((v) => ({ name: v.name, type: v.type })),
            });
          }
        }
      }

      // ── Rules ──────────────────────────────────────────────────────────
      const rulesMetrics: RulesMetrics[] = [];
      if (want("rules")) {
        const all = await tm1Client.cubes.getAllRules(includeControl);
        for (const r of all) {
          rulesMetrics.push(computeRulesMetrics(r.cubeName, r.rulesText));
        }
      }

      // ── Cross-process consistency ──────────────────────────────────────
      const consistency = want("consistency")
        ? {
            variableClusters: clusterVariableNames(processVarInputs),
            typeConflicts: findTypeInconsistencies(processVarInputs),
            prefixConvention: reportPrefixConvention(processVarInputs),
            cohorts: groupByCohort(processVarInputs),
          }
        : null;

      // ── Sort + filter + cap ────────────────────────────────────────────
      const processesScanned = processMetrics.length;
      const rulesScanned = rulesMetrics.length;
      processMetrics.sort((a, b) => b.totals.score - a.totals.score);
      rulesMetrics.sort((a, b) => b.score - a.score);

      const topProcesses = processMetrics
        .filter((m) => m.totals.score >= scoreThreshold)
        .slice(0, topN);
      const topRules = rulesMetrics
        .filter((m) => m.score >= scoreThreshold)
        .slice(0, topN);

      // At default scoreThreshold=0 the score formula (loc + 2*branches +
      // 3*nesting) is >= 1 for any non-empty process, so gating status on
      // topProcesses/topRules would mark every run "fail". Gate process/rules
      // contributions to status only when the caller opted into a threshold.
      const thresholdActive = scoreThreshold > 0;
      const consistencyIssues =
        consistency !== null &&
        (consistency.variableClusters.length > 0 ||
          consistency.typeConflicts.length > 0);
      const status =
        consistencyIssues ||
        (thresholdActive && (topProcesses.length > 0 || topRules.length > 0))
          ? "fail"
          : "pass";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status,
                productVersion: serverInfo.productVersion,
                scope: activeScope,
                includeControl,
                scanned: {
                  processes: processesScanned,
                  rules: rulesScanned,
                },
                summary: {
                  processes: {
                    totalLoc: processMetrics.reduce((a, m) => a + m.totals.loc, 0),
                    totalBranches: processMetrics.reduce(
                      (a, m) => a + m.totals.branches,
                      0,
                    ),
                    maxNesting: processMetrics.reduce(
                      (a, m) => Math.max(a, m.totals.maxNesting),
                      0,
                    ),
                    avgCommentRatio:
                      processesScanned === 0
                        ? 0
                        : processMetrics.reduce(
                            (a, m) => a + m.totals.commentRatio,
                            0,
                          ) / processesScanned,
                  },
                  rules: {
                    totalRulesLoc: rulesMetrics.reduce(
                      (a, m) => a + m.rulesLoc,
                      0,
                    ),
                    totalRuleCount: rulesMetrics.reduce(
                      (a, m) => a + m.ruleCount,
                      0,
                    ),
                    totalDbCalls: rulesMetrics.reduce(
                      (a, m) => a + m.dbCallCount,
                      0,
                    ),
                    cubesWithoutSkipcheck: rulesMetrics
                      .filter((m) => !m.hasSkipcheck && m.rulesLoc > 0)
                      .map((m) => m.cube),
                  },
                },
                topProcesses,
                topRules,
                consistency,
                truncated: {
                  processes: processMetrics.length > topProcesses.length,
                  rules: rulesMetrics.length > topRules.length,
                },
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
