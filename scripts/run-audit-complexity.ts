#!/usr/bin/env tsx
/**
 * Live runner — exercises tm1_audit_complexity directly against the configured
 * TM1 server, bypassing MCP transport (host may not have reloaded the new
 * rankBy/weights params yet). Runs both rankings and reports where v2 (loop
 * nesting multiplies, condition complexity, hot ops in loops) disagrees with
 * v1 (loc + 2*branches + 3*maxNesting). Not shipped, not in npm verify.
 *
 * Run: npx tsx scripts/run-audit-complexity.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { TM1Client } from "../src/tm1-client.js";
import { registerAuditComplexity } from "../src/tools/analysis/audit-complexity.js";
import pino from "pino";
import { z, type ZodRawShape } from "zod";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface Totals {
  loc: number;
  branches: number;
  maxNesting: number;
  score: number;
  loopCost: number;
  ifCost: number;
  hotInLoop: number;
  scoreV2: number;
  commentRatio: number;
}
interface ProcEntry {
  name: string;
  totals: Totals;
}

function makeHandler(tm1: TM1Client): {
  handler: ToolHandler;
  parse: (a: Record<string, unknown>) => Record<string, unknown>;
} {
  let handler: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const fakeServer = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      handler = h;
      parser = z.object(schema);
    },
  } as unknown as Parameters<typeof registerAuditComplexity>[0];
  registerAuditComplexity(fakeServer, tm1);
  if (!handler || !parser) throw new Error("tool did not register");
  const p = parser;
  return { handler, parse: (a) => p.parse(a) as Record<string, unknown> };
}

async function run(
  h: { handler: ToolHandler; parse: (a: Record<string, unknown>) => Record<string, unknown> },
  args: Record<string, unknown>,
): Promise<{ topProcesses: ProcEntry[]; scanned: { processes: number } }> {
  const res = (await h.handler(h.parse(args))) as { content: Array<{ text: string }> };
  return JSON.parse(res.content[0]!.text);
}

async function main() {
  const config = loadConfig();
  const logger = pino({ level: "warn" });
  const sessions = new SessionManager(config, logger);
  const tm1 = new TM1Client(config, sessions, logger);
  await tm1.connect();

  const h = makeHandler(tm1);
  const common = { scope: ["processes"], topN: 200 };

  const v1 = await run(h, { ...common, rankBy: "scoreV1" });
  const v2 = await run(h, { ...common, rankBy: "scoreV2" });

  console.log(`scanned processes: ${v1.scanned.processes}`);

  const rank = (list: ProcEntry[]) => {
    const m = new Map<string, number>();
    list.forEach((p, i) => m.set(p.name, i + 1));
    return m;
  };
  const r1 = rank(v1.topProcesses);

  console.log("\n=== TOP 15 by v2 (scoreV2) ===");
  console.log("rank  v1→v2   scoreV1  scoreV2  loop   if   hotLoop  nest  name");
  for (let i = 0; i < Math.min(15, v2.topProcesses.length); i++) {
    const p = v2.topProcesses[i]!;
    const t = p.totals;
    const v1rank = r1.get(p.name) ?? -1;
    const move = v1rank === i + 1 ? "  =" : `${v1rank}→${i + 1}`;
    console.log(
      `${String(i + 1).padStart(4)}  ${move.padStart(6)}  ${String(t.score).padStart(7)}  ${t.scoreV2.toFixed(0).padStart(7)}  ${String(t.loopCost).padStart(4)}  ${String(t.ifCost).padStart(4)}  ${String(t.hotInLoop).padStart(6)}  ${String(t.maxNesting).padStart(4)}  ${p.name}`,
    );
  }

  // Biggest rank climbers under v2 (v2 surfaces what v1 missed).
  const climbers = v2.topProcesses
    .map((p, i) => ({ name: p.name, v1: r1.get(p.name) ?? 9999, v2: i + 1, t: p.totals }))
    .filter((x) => x.v1 - x.v2 >= 3)
    .sort((a, b) => b.v1 - b.v2 - (a.v1 - a.v2))
    .slice(0, 10);

  console.log("\n=== Biggest v2 climbers (v2 ranks much higher than v1) ===");
  if (climbers.length === 0) console.log("(none — v1 and v2 broadly agree)");
  for (const c of climbers) {
    console.log(
      `  ${c.name}: v1#${c.v1} → v2#${c.v2}  (loopCost=${c.t.loopCost} hotInLoop=${c.t.hotInLoop} ifCost=${c.t.ifCost})`,
    );
  }

  await tm1.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
