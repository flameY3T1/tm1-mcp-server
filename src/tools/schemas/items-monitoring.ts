// Monitoring/server-domain schemas: server info & state, message/transaction/
// audit/error logs, threads, jobs and sessions.
import { z } from "zod";

import { CellValueSchema } from "./items-common.js";

export const ServerInfoSchema = z
  .object({
    serverName: z.string(),
    productVersion: z.string(),
    productEdition: z.string().optional(),
    adminHost: z.string().optional(),
    dataDirectory: z.string().optional(),
    timeZoneId: z.string().optional(),
    integratedSecurityMode: z.string().optional(),
    modelling: z.unknown().optional(),
    ti: z.unknown().optional(),
    rules: z.unknown().optional(),
    mtq: z.unknown().optional(),
    jobQueuing: z.unknown().optional(),
    memory: z.unknown().optional(),
    logging: z.unknown().optional(),
    http: z.unknown().optional(),
    security: z.unknown().optional(),
    _raw: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const MessageLogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  errorFile: z.string().optional(),
});

export const TransactionLogEntrySchema = z.object({
  timestamp: z.string(),
  user: z.string(),
  cubeName: z.string(),
  elements: z.array(z.string()),
  oldValue: CellValueSchema,
  newValue: CellValueSchema,
});

const AuditLogDetailSchema = z.object({
  id: z.number().int(),
  timestamp: z.string(),
  user: z.string(),
  description: z.string(),
  objectType: z.string(),
  objectName: z.string(),
});

export const AuditLogEntrySchema = AuditLogDetailSchema.extend({
  details: z.array(AuditLogDetailSchema).optional(),
});

export const ErrorLogFileSchema = z.object({
  filename: z.string(),
  lastUpdated: z.string().optional(),
});

// groupBy='process' audit-summary item: per-process failure aggregation.
export const ErrorLogGroupSchema = z.object({
  process: z.string(),
  count: z.number().int(),
  firstSeen: z.string().nullable(),
  lastSeen: z.string().nullable(),
  spanDays: z.number().int(),
  perDay: z.number(),
});

const RelatedErrorLogFileSchema = z.object({
  filename: z.string(),
  deltaSec: z.number().int(),
  totalBytes: z.number().int().optional(),
  returnedBytes: z.number().int().optional(),
  truncated: z.boolean().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
});

export const ErrorLogContentResultSchema = z.object({
  filename: z.string(),
  totalBytes: z.number().int(),
  returnedBytes: z.number().int(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  content: z.string(),
  related: z
    .object({
      windowSec: z.number().int().optional(),
      found: z.number().int().optional(),
      maxFiles: z.number().int().optional(),
      note: z.string().optional(),
      files: z.array(RelatedErrorLogFileSchema),
    })
    .optional(),
});

export const ThreadItemSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  state: z.string(),
  function: z.string(),
  objectName: z.string(),
  elapsedTime: z.string().optional(),
  objectType: z.string().optional(),
  lockType: z.string().optional(),
  waitTime: z.string().optional(),
  info: z.string().optional(),
  context: z.string().optional(),
});

export const JobItemSchema = z.object({
  id: z.string(),
  description: z.string(),
  state: z.string(),
  elapsedTime: z.string().optional(),
  waitTime: z.string().optional(),
  session: z
    .object({
      id: z.string(),
      context: z.string().optional(),
      user: z.string().optional(),
    })
    .optional(),
  waitingOn: z
    .array(z.object({ id: z.string(), description: z.string(), state: z.string() }))
    .optional(),
});

export const SessionItemSchema = z.object({
  id: z.string(),
  user: z.string(),
  active: z.boolean().optional(),
  threads: z.array(ThreadItemSchema),
});

// Server state snapshot curates a few config flags whose surface differs
// per TM1 build — every section is permissive (.passthrough()).
export const ServerStateResultSchema = z
  .object({
    connected: z.boolean(),
    server: z.unknown(),
    capabilities: z.unknown(),
    counts: z.unknown(),
  })
  .passthrough();
