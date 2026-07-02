import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";

export function registerUpdateChore(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_update_chore",
    "Update an existing TM1 chore. Only the provided fields are changed.",
    {
      name: z.string().describe("Chore name (case-sensitive)"),
      startTime: z.string().optional().describe("New start time in ISO 8601 format"),
      active: z.boolean().optional().describe("Enable or disable the chore schedule"),
      dstSensitive: z.boolean().optional().describe("Adjust for daylight saving time"),
      executionMode: z.enum(["SingleCommit", "MultipleCommit"]).optional(),
      frequency: z.object({
        days: z.number().int().min(0),
        hours: z.number().int().min(0).max(23),
        minutes: z.number().int().min(0).max(59),
        seconds: z.number().int().min(0).max(59),
      }).optional(),
      steps: z.array(z.object({
        process: z.string(),
        parameters: z.array(z.object({
          name: z.string(),
          value: z.union([z.string(), z.number()]),
        })).optional().default([]),
      })).optional().describe("Replace all steps (full replacement, not partial)"),
    },
    async ({ name, ...updates }) => {
      let coerced = false;
      if (updates.startTime !== undefined && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(updates.startTime)) {
        updates.startTime = `${updates.startTime}Z`;
        coerced = true;
      }
      await tm1Client.chores.update(name, updates);
      const payload = {
        success: true,
        choreName: name,
        ...(updates.startTime !== undefined ? { startTime: updates.startTime } : {}),
        ...(coerced ? {
          warning: `startTime had no timezone offset; auto-appended 'Z' → '${updates.startTime}'. Pass an explicit offset to silence this.`,
        } : {}),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );
}
