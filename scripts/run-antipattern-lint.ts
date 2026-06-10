#!/usr/bin/env tsx
/**
 * Live runner — exercises tm1_audit_complexity scope='antipatterns' directly
 * against the configured TM1 server, bypassing MCP transport (host may not have
 * reloaded the new scope yet). Prints the severity summary and groups findings
 * by rule so the catalog can be calibrated against a real model. Not shipped,
 * not in npm verify.
 *
 * Run: npx tsx scripts/run-antipattern-lint.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { TM1Client } from "../src/tm1-client.js";
import { registerAuditComplexity } from "../src/tools/analysis/audit-complexity.js";
import pino from "pino";
import { z, type ZodRawShape } from "zod";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface Finding {
  process: string;
  tab: string;
  line: number;
  rule: string;
  severity: "error" | "warn" | "info";
  snippet: string;
  hint: string;
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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: "warn" });
  const sessions = new SessionManager(config, logger);
  const tm1 = new TM1Client(config, sessions, logger);
  const h = makeHandler(tm1);

  const res = (await h.handler(
    h.parse({ scope: ["antipatterns"], topN: 500 }),
  )) as { content: Array<{ text: string }> };
  const out = JSON.parse(res.content[0]!.text) as {
    status: string;
    scanned: { processes: number };
    antipatterns: {
      summary: Record<string, number>;
      findings: Finding[];
      truncated: boolean;
    };
  };

  const { summary, findings, truncated } = out.antipatterns;
  console.log(`status=${out.status}  processes=${out.scanned.processes}`);
  console.log(`summary:`, summary, truncated ? "(truncated)" : "");

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byRule.get(f.rule) ?? [];
    arr.push(f);
    byRule.set(f.rule, arr);
  }
  for (const [rule, arr] of [...byRule.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    console.log(`\n## ${rule}  (${arr.length})`);
    for (const f of arr.slice(0, 8)) {
      console.log(
        `  ${f.severity.padEnd(5)} ${f.process} [${f.tab}:${f.line}]  ${f.snippet}`,
      );
    }
    if (arr.length > 8) console.log(`  … +${arr.length - 8} more`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
