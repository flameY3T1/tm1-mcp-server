import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: vi.fn().mockReturnThis(),
  level: "silent",
  flush: vi.fn(),
} as unknown as pino.Logger;

// Capture each registered tool's inputSchema (the raw zod shape) by intercepting
// registerTool, mirroring tests/unit/tool-registration.test.ts.
function collectInputSchemas(): Map<string, Record<string, unknown>> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const schemas = new Map<string, Record<string, unknown>>();
  const original = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    const name = args[0] as string;
    const config = args[1] as { inputSchema?: Record<string, unknown> };
    schemas.set(name, config?.inputSchema ?? {});
    return (original as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof server.registerTool>;
  };
  registerAllTools(withAnnotations(server, mockLogger, "readwrite"), {} as TM1Client);
  return schemas;
}

// Tools that MUST carry the confirmation guard (CONFIRM_SCHEMA `confirm` field).
// Losing it silently would let an auto-approve client fire an irreversible
// destructive op without repeating the target name. This gate fails if any of
// these drops the field.
//
// NOTE: the destructive surface is wider than this set (delete_element/hierarchy/
// subset/view/chore/client/file, remove_client_group). Extending confirm to those
// is deliberately deferred (audit H4 coverage gap) — it changes those tool
// contracts and needs the live suite re-run against a server. Tracked in
// docs/internal/audit-2026-07-03-beyond-basics.md.
const CONFIRM_REQUIRED = [
  "tm1_delete_process",
  "tm1_clear_cube",
  "tm1_delete_cube",
  "tm1_delete_dimension",
];

describe("confirmation-guard coverage", () => {
  const schemas = collectInputSchemas();

  it.each(CONFIRM_REQUIRED)("%s declares a `confirm` input", (toolName) => {
    const inputSchema = schemas.get(toolName);
    expect(inputSchema, `${toolName} is not registered`).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(inputSchema, "confirm"),
      `${toolName} must declare a \`confirm\` field (CONFIRM_SCHEMA) to guard the destructive action`,
    ).toBe(true);
  });
});
