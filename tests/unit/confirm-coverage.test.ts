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
// H4-full (2026-07-04): the guard now covers the whole object-destruction
// surface. remove_client_group is technically reversible (re-assign) but guards
// on clientName so an auto-approve client can't silently strip memberships.
const CONFIRM_REQUIRED = [
  "tm1_delete_process",
  "tm1_clear_cube",
  "tm1_delete_cube",
  "tm1_delete_dimension",
  "tm1_delete_element",
  "tm1_delete_hierarchy",
  "tm1_delete_subset",
  "tm1_delete_view",
  "tm1_delete_chore",
  "tm1_delete_client",
  "tm1_delete_file",
  "tm1_remove_client_group",
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
