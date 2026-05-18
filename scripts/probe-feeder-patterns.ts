#!/usr/bin/env tsx
/**
 * Discovery probe — NOT a production tool, NOT shipped.
 *
 * Pulls every cube's rules from the configured TM1 server, runs them through
 * the existing parseRules / extractBracketRefs / extractDbCalls helpers, and
 * reports raw counts + a handful of samples per pattern. Purpose: ground the
 * tm1_audit_feeders spec on real data instead of assumptions.
 *
 * Run: TM1_PASSWORD=<pw> npx tsx scripts/probe-feeder-patterns.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { TM1Client } from "../src/tm1-client.js";
import pino from "pino";
import { parseRules } from "../src/lib/callgraph/rulesParser.js";
import {
  extractBracketRefs,
  extractDbCalls,
  parseBracketDimRefs,
} from "../src/lib/callgraph/rulesLinter.js";

interface CubePatterns {
  cube: string;
  totalLines: number;
  rulesLines: number;
  feedersLines: number;
  hasFeedstrings: boolean;
  hasSkipcheck: boolean;
  /** Feeder lines using `IF(... , ...)` / `STET` / `IFEED`. */
  conditionalFeeders: number;
  /** Feeder lines containing `DB(...)`. */
  feedersWithDb: number;
  /** Feeder lines whose LHS bracket list contains an element. */
  feedersWithElements: number;
  /** Feeder lines whose LHS bracket list looks wildcard-ish (no element token). */
  feedersWildcardish: number;
  /** Rules lines using `IF(...)` on the LHS — conditional rule that needs IFEED. */
  conditionalRules: number;
  /** Feeder line samples (max 3). */
  samplesFeeders: string[];
  /** Rule line samples (max 3). */
  samplesRules: string[];
}

const IFEED_RE = /\b(IFEED|STET)\b/i;
const IF_LINE_RE = /^\s*IF\s*\(/i;

function classifyCube(cube: string, rulesText: string): CubePatterns | null {
  if (!rulesText || rulesText.trim() === "") return null;
  const ast = parseRules(rulesText);
  let rulesLines = 0;
  let feedersLines = 0;
  let conditionalFeeders = 0;
  let feedersWithDb = 0;
  let feedersWithElements = 0;
  let feedersWildcardish = 0;
  let conditionalRules = 0;
  const samplesFeeders: string[] = [];
  const samplesRules: string[] = [];

  for (const line of ast.lines) {
    if (line.isBlank || line.isComment) continue;
    if (line.section === "rules") {
      rulesLines++;
      if (IF_LINE_RE.test(line.trimmed)) conditionalRules++;
      if (samplesRules.length < 3 && line.trimmed.startsWith("[")) {
        samplesRules.push(line.trimmed);
      }
    } else {
      feedersLines++;
      if (IFEED_RE.test(line.trimmed) || IF_LINE_RE.test(line.trimmed)) {
        conditionalFeeders++;
      }
      const dbCalls = extractDbCalls(line.trimmed);
      if (dbCalls.length > 0) feedersWithDb++;

      const dimRefs = parseBracketDimRefs(line.trimmed.split("=>")[0] ?? line.trimmed);
      const hasAnyElement = dimRefs.some((r) => r.elems.length > 0);
      const looksWildcard =
        dimRefs.length > 0 && dimRefs.every((r) => r.elems.length === 0);
      if (hasAnyElement) feedersWithElements++;
      if (looksWildcard) feedersWildcardish++;

      if (samplesFeeders.length < 3 && line.trimmed.length > 0) {
        samplesFeeders.push(line.trimmed);
      }
    }
  }

  return {
    cube,
    totalLines: ast.lines.length,
    rulesLines,
    feedersLines,
    hasFeedstrings: ast.hasFeedstrings,
    hasSkipcheck: ast.hasSkipcheck,
    conditionalFeeders,
    feedersWithDb,
    feedersWithElements,
    feedersWildcardish,
    conditionalRules,
    samplesFeeders,
    samplesRules,
  };
}

async function main() {
  const config = loadConfig();
  const logger = pino({ level: "warn" });
  const sessions = new SessionManager(config, logger);
  const tm1 = new TM1Client(config, sessions, logger);
  await tm1.connect();

  const all = await tm1.cubes.getAllRules(false);
  const patterns: CubePatterns[] = [];
  for (const c of all) {
    const p = classifyCube(c.cubeName, c.rulesText);
    if (p) patterns.push(p);
  }

  const totals = {
    cubesWithAnyRules: patterns.length,
    cubesWithFeeders: patterns.filter((p) => p.feedersLines > 0).length,
    cubesWithFeedstrings: patterns.filter((p) => p.hasFeedstrings).length,
    cubesWithSkipcheck: patterns.filter((p) => p.hasSkipcheck).length,
    cubesWithoutSkipcheck: patterns.filter((p) => !p.hasSkipcheck && p.rulesLines > 0)
      .length,
    sumFeederLines: patterns.reduce((a, p) => a + p.feedersLines, 0),
    sumConditionalFeeders: patterns.reduce((a, p) => a + p.conditionalFeeders, 0),
    sumFeedersWithDb: patterns.reduce((a, p) => a + p.feedersWithDb, 0),
    sumFeedersWildcardish: patterns.reduce((a, p) => a + p.feedersWildcardish, 0),
    sumFeedersWithElements: patterns.reduce((a, p) => a + p.feedersWithElements, 0),
    sumConditionalRules: patterns.reduce((a, p) => a + p.conditionalRules, 0),
  };

  const topByFeederCount = [...patterns]
    .sort((a, b) => b.feedersLines - a.feedersLines)
    .slice(0, 5);

  const conditionalRulesNoIfeed = patterns.filter(
    (p) => p.conditionalRules > 0 && p.conditionalFeeders === 0 && p.feedersLines > 0,
  );

  const wildcardishHeavy = patterns
    .filter((p) => p.feedersWildcardish > 0)
    .sort((a, b) => b.feedersWildcardish - a.feedersWildcardish)
    .slice(0, 5);

  console.log(JSON.stringify(
    {
      totals,
      topByFeederCount,
      conditionalRulesNoIfeedCount: conditionalRulesNoIfeed.length,
      conditionalRulesNoIfeedSamples: conditionalRulesNoIfeed.slice(0, 5),
      wildcardishHeavy,
      bracketRefDemo: (() => {
        const sample = patterns.find((p) => p.samplesFeeders.length > 0);
        if (!sample) return null;
        const line = sample.samplesFeeders[0]!;
        return {
          cube: sample.cube,
          line,
          dimRefs: parseBracketDimRefs(line),
          extractBracketRefs: extractBracketRefs(line),
          dbCalls: extractDbCalls(line),
        };
      })(),
    },
    null,
    2,
  ));

  await tm1.disconnect();
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
