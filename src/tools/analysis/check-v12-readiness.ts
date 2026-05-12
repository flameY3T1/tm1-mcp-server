import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../tm1-client.js";
import { scanForDeprecatedTi, type ScanHit } from "../../lib/v12-compat/scanner.js";

const RULESET_SOURCE =
  "vscode-tm1-ti@cf73b93 / tiSignatures.ts (synced 2026-05-12)";

type Finding = {
  severity: "error" | "warning";
  category: "deprecated_ti_function";
  objectKind: "process" | "cube";
  objectName: string;
  section: "prolog" | "metadata" | "data" | "epilog" | "rules";
  line: number;
  function: string;
  snippet: string;
  issue: string;
  suggestion: string;
};

function toFinding(
  hit: ScanHit,
  objectKind: Finding["objectKind"],
  objectName: string,
  section: Finding["section"],
): Finding {
  return {
    severity: hit.severity,
    category: "deprecated_ti_function",
    objectKind,
    objectName,
    section,
    line: hit.line,
    function: hit.function,
    snippet: hit.snippet,
    issue: hit.issue,
    suggestion: hit.suggestion,
  };
}

export function registerCheckV12Readiness(server: McpServer, tm1Client: TM1Client) {
  server.tool(
    "tm1_check_v12_readiness",
    [
      "Static gap-analysis against the TM1 / Planning Analytics v12 (Cloud Native) deprecation list.",
      "Scans every TI process section (prolog/metadata/data/epilog) and every cube rule for calls",
      "to functions that have been removed in v12, returning structured findings with severity,",
      "location, and migration hint per occurrence.",
      "Read-only, two bulk REST calls (Processes + Cubes/Rules). Replaces the agent-side workflow",
      "of pulling all code and matching against a checklist — saves tokens on models with >50 processes.",
      "Not exhaustive: covers syntactic deprecations only (runtime/semantic differences require manual review).",
    ].join(" "),
    {
      scope: z
        .enum(["processes", "rules", "all"])
        .optional()
        .default("all")
        .describe("Restrict scan to TI processes, cube rules, or both (default 'all')."),
      includeControl: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include control objects ('}'-prefix names). Default false."),
      maxFindings: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .default(500)
        .describe("Cap on returned findings (default 500). Summary counters still reflect the full scan."),
    },
    async ({ scope, includeControl, maxFindings }) => {
      const findings: Finding[] = [];
      let scannedProcesses = 0;
      let scannedCubes = 0;

      const wantProcesses = scope === "all" || scope === "processes";
      const wantRules = scope === "all" || scope === "rules";

      const [procCodes, cubeRules] = await Promise.all([
        wantProcesses ? tm1Client.processes.getAllCode(includeControl) : Promise.resolve([]),
        wantRules ? tm1Client.cubes.getAllRules(includeControl) : Promise.resolve([]),
      ]);

      if (wantProcesses) {
        scannedProcesses = procCodes.length;
        for (const p of procCodes) {
          const sections: Array<[Finding["section"], string]> = [
            ["prolog", p.prolog],
            ["metadata", p.metadata],
            ["data", p.data],
            ["epilog", p.epilog],
          ];
          for (const [section, body] of sections) {
            for (const hit of scanForDeprecatedTi(body)) {
              findings.push(toFinding(hit, "process", p.name, section));
            }
          }
        }
      }

      if (wantRules) {
        scannedCubes = cubeRules.length;
        for (const r of cubeRules) {
          for (const hit of scanForDeprecatedTi(r.rulesText)) {
            findings.push(toFinding(hit, "cube", r.cubeName, "rules"));
          }
        }
      }

      // Aggregations across the FULL finding set, before truncation.
      const bySeverity: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      const fnCounts = new Map<string, number>();
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
        byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
        fnCounts.set(f.function, (fnCounts.get(f.function) ?? 0) + 1);
      }
      const topFunctions = Array.from(fnCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([fn, count]) => ({ function: fn, count }));

      const errorCount = bySeverity.error ?? 0;
      const warningCount = bySeverity.warning ?? 0;
      const readinessScore =
        errorCount === 0 && warningCount === 0
          ? "ready"
          : errorCount > 0
            ? "blocked"
            : "needs-work";

      findings.sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
        if (a.objectName !== b.objectName) return a.objectName.localeCompare(b.objectName);
        return a.line - b.line;
      });

      const trimmed = findings.slice(0, maxFindings);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                scope,
                includeControl,
                scannedProcesses,
                scannedCubes,
                findingsCount: findings.length,
                readinessScore,
                summary: { byCategory, bySeverity, topFunctions },
                findings: trimmed,
                rulesetSource: RULESET_SOURCE,
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
