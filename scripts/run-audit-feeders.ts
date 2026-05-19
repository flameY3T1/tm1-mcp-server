#!/usr/bin/env tsx
/**
 * Live runner — exercises the tm1_audit_feeders tool handler directly
 * against the configured TM1 server, bypassing MCP transport. Useful when
 * the MCP host hasn't reloaded yet after a tool addition. Not shipped, not
 * in npm verify.
 *
 * Run: npx tsx scripts/run-audit-feeders.ts
 */
import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { SessionManager } from "../src/session-manager.js";
import { TM1Client } from "../src/tm1-client.js";
import { registerAuditFeeders } from "../src/tools/analysis/audit-feeders.js";
import pino from "pino";
import { z, type ZodRawShape } from "zod";

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

async function main() {
  const config = loadConfig();
  const logger = pino({ level: "warn" });
  const sessions = new SessionManager(config, logger);
  const tm1 = new TM1Client(config, sessions, logger);
  await tm1.connect();

  let handler: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const fakeServer = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      handler = h;
      parser = z.object(schema);
    },
  } as unknown as Parameters<typeof registerAuditFeeders>[0];
  registerAuditFeeders(fakeServer, tm1);
  if (!handler || !parser) throw new Error("tool did not register");

  const mode = process.env.AUDIT_MODE ?? "static";
  const args = parser.parse({ mode });
  const result = (await handler(args)) as { content: Array<{ text: string }> };
  console.log(result.content[0]!.text);

  await tm1.disconnect();
}

main().catch((err) => {
  console.error("run failed:", err);
  process.exit(1);
});
