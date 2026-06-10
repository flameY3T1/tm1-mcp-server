import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { ANNOTATION_MAP } from "../../src/tools/annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";
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

function makeServer(): McpServer {
  return new McpServer({ name: "test", version: "0.0.0" });
}

function collectRegisteredNames(mode: "readwrite" | "readonly"): Set<string> {
  const server = makeServer();
  const names = new Set<string>();
  const original = server.registerTool.bind(server);
  server.registerTool = (...args: unknown[]) => {
    names.add(args[0] as string);
    return (original as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof server.registerTool>;
  };
  const wrapped = withAnnotations(server, mockLogger, mode);
  registerAllTools(wrapped, {} as TM1Client);
  return names;
}

describe("#9 map reconciliation", () => {
  it("registered tool names === ANNOTATION_MAP keys (no orphans, no gaps)", () => {
    const registered = collectRegisteredNames("readwrite");
    const annotated = new Set(Object.keys(ANNOTATION_MAP));
    expect([...registered].sort()).toEqual([...annotated].sort());
  });

  it("OUTPUT_SCHEMA_MAP keys ⊆ registered tools (every schema'd tool is registered)", () => {
    const registered = collectRegisteredNames("readwrite");
    const schemaKeys = Object.keys(OUTPUT_SCHEMA_MAP);
    const missing = schemaKeys.filter((k) => !registered.has(k));
    expect(missing).toEqual([]);
  });
});

describe("#8 readonly mode", () => {
  it("only readOnlyHint=true tools are registered in readonly mode", () => {
    const registered = collectRegisteredNames("readonly");
    const readOnlyNames = new Set(
      Object.entries(ANNOTATION_MAP)
        .filter(([, annot]) => annot.readOnlyHint)
        .map(([name]) => name),
    );
    expect([...registered].sort()).toEqual([...readOnlyNames].sort());
  });

  it("write tools are NOT registered in readonly mode", () => {
    const registered = collectRegisteredNames("readonly");
    const writeNames = Object.entries(ANNOTATION_MAP)
      .filter(([, annot]) => !annot.readOnlyHint)
      .map(([name]) => name);
    for (const name of writeNames) {
      expect(registered.has(name), `${name} should not be registered in readonly mode`).toBe(false);
    }
  });
});
