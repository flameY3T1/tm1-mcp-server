import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

function coerceUtc(iso: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
}

const ChoreStepSchema = z.object({
  process: z.string().describe("TI process name"),
  parameters: z.array(z.object({
    name: z.string(),
    value: z.union([z.string(), z.number()]),
  })).optional().default([]),
});

export function registerCreateChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_create_chore",
    "Create a new TM1 chore with a schedule and list of TI processes to run.",
    {
      name: z.string().describe("Chore name"),
      startTime: z.string().describe(
        "Start time in ISO 8601 format with timezone (Z or ±HH:MM). If no offset is given, UTC ('Z') is auto-appended. Example: '2025-01-01T06:00:00Z'.",
      ),
      active: z.boolean().optional().default(false)
        .describe("Whether to activate the chore immediately (default: false)"),
      dstSensitive: z.boolean().optional().default(true)
        .describe("Whether the schedule adjusts for daylight saving time (default: true)"),
      executionMode: z.enum(["SingleCommit", "MultipleCommit"]).optional().default("MultipleCommit")
        .describe("SingleCommit: all steps in one transaction. MultipleCommit: each step commits independently."),
      frequency: z.object({
        days: z.number().int().min(0).default(1),
        hours: z.number().int().min(0).max(23).default(0),
        minutes: z.number().int().min(0).max(59).default(0),
        seconds: z.number().int().min(0).max(59).default(0),
      }).describe("How often the chore runs"),
      steps: z.array(ChoreStepSchema).min(1).describe("Ordered list of TI processes to execute"),
    },
    async ({ name, startTime, active, dstSensitive, executionMode, frequency, steps }) => {
      try {
        await tm1Client.createChore({ name, startTime: coerceUtc(startTime), active, dstSensitive, executionMode, frequency, steps });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, name, stepCount: steps.length, active }, null, 2),
          }],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: `TM1 error: ${(err as Error).message}` }] };
      }
    },
  );
}
