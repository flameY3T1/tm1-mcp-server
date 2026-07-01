import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TM1Client } from "../../tm1-client.js";
import { FORMAT_SCHEMA, payloadResponse, renderTable, type Column } from "../format.js";

export function registerGetAuditLog(server: McpServer, tm1Client: TM1Client): void {
  server.tool(
    "tm1_get_audit_log",
    "Fetch recent TM1 audit log entries (metadata/security changes: who changed what, when), newest first. " +
      "Requires AuditLogOn=T in tm1s.cfg — an empty result on an active server usually means auditing is disabled " +
      "(check auditLogEnabled in tm1_get_server_info).",
    {
      top: z.number().int().min(1).max(1000).optional().default(100)
        .describe("Max entries to return (default: 100, max: 1000)"),
      user: z.string().optional().describe("Filter to one user name"),
      objectType: z.string().optional()
        .describe("Filter to one object type, e.g. 'Cube', 'Dimension', 'Process', 'User', 'Chore', 'Server'"),
      objectName: z.string().optional().describe("Filter to one object name"),
      since: z.string().optional()
        .describe("Only entries on or after this ISO timestamp, e.g. '2026-06-01T00:00:00Z'"),
      until: z.string().optional()
        .describe("Only entries on or before this ISO timestamp"),
      includeDetails: z.boolean().optional().default(false)
        .describe("Expand per-entry audit details (nested change records)"),
      ...FORMAT_SCHEMA,
    },
    async ({ top, user, objectType, objectName, since, until, includeDetails, format }) => {
      const entries = await tm1Client.server.getAuditLog({
        top, user, objectType, objectName, since, until, includeDetails,
      });
      const payload = { count: entries.length, entries };
      type Row = (typeof entries)[number];
      const columns: Column<Row>[] = [
        { header: "timestamp", get: (e) => e.timestamp },
        { header: "user", get: (e) => e.user },
        { header: "objectType", get: (e) => e.objectType },
        { header: "objectName", get: (e) => e.objectName },
        { header: "description", get: (e) => e.description },
      ];
      return payloadResponse(payload, format, (p) =>
        `## Audit log\n\n${p.count} entries\n\n${renderTable(p.entries, columns)}`,
      );
    },
  );
}
