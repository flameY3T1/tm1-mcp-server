import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import type { TM1Client } from "../../src/tm1-client.js";
import { ANNOTATION_MAP } from "../../src/tools/annotation-map.js";
import { OUTPUT_SCHEMA_MAP } from "../../src/tools/output-schema-map.js";
import { registerAllTools } from "../../src/tools/index.js";
import { withAnnotations, deriveTitle } from "../../src/tools/with-annotations.js";

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

// Version-gated tools (tm1_list_jobs/tm1_cancel_job on v12, tm1_list_threads/
// tm1_cancel_thread on v11) only register under one version at a time — union
// both so "registered" reflects full coverage across the version split.
function collectRegisteredNames(mode: "readwrite" | "readonly"): Set<string> {
  const names = new Set<string>();
  for (const version of [11, 12] as const) {
    const server = makeServer();
    const original = server.registerTool.bind(server);
    server.registerTool = (...args: unknown[]) => {
      names.add(args[0] as string);
      return (original as (...a: unknown[]) => unknown)(...args) as ReturnType<typeof server.registerTool>;
    };
    const wrapped = withAnnotations(server, mockLogger, mode);
    registerAllTools(wrapped, { version } as unknown as TM1Client);
  }
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

// Capture (config, wrappedCb) per tool name so registration-level behavior
// (title injection, output-schema drift guard) can be asserted directly.
function captureRegistrations(): Map<
  string,
  { config: Record<string, unknown>; cb: (...a: unknown[]) => unknown }
> {
  const server = makeServer();
  const captured = new Map<
    string,
    { config: Record<string, unknown>; cb: (...a: unknown[]) => unknown }
  >();
  server.registerTool = ((...args: unknown[]) => {
    captured.set(args[0] as string, {
      config: args[1] as Record<string, unknown>,
      cb: args[2] as (...a: unknown[]) => unknown,
    });
    return {} as ReturnType<typeof server.registerTool>;
  }) as typeof server.registerTool;
  const wrapped = withAnnotations(server, mockLogger, "readwrite");
  registerAllTools(wrapped, {} as TM1Client);
  return captured;
}

describe("L8 auto-derived tool titles", () => {
  it("deriveTitle: strips tm1_, capitalizes words, keeps acronym casing", () => {
    expect(deriveTitle("tm1_get_process_code")).toBe("Get Process Code");
    expect(deriveTitle("tm1_list_cubes")).toBe("List Cubes");
    expect(deriveTitle("tm1_execute_mdx")).toBe("Execute MDX");
    expect(deriveTitle("tm1_create_mdx_view")).toBe("Create MDX View");
    expect(deriveTitle("tm1_check_v12_readiness")).toBe("Check v12 Readiness");
    expect(deriveTitle("no_prefix_tool")).toBe("No Prefix Tool");
  });

  it("every registered tool carries a derived title in its config", () => {
    const captured = captureRegistrations();
    expect(captured.size).toBeGreaterThan(0);
    for (const [name, { config }] of captured) {
      expect(config.title, `${name} missing title`).toBe(deriveTitle(name));
    }
    expect(captured.get("tm1_list_cubes")?.config.title).toBe("List Cubes");
  });
});

describe("L9 output-schema drift guard", () => {
  const mkResult = (payload: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });

  function registerFake(
    name: string,
    handler: () => unknown,
  ): { config: Record<string, unknown>; cb: (...a: unknown[]) => unknown } {
    const server = makeServer();
    let captured:
      | { config: Record<string, unknown>; cb: (...a: unknown[]) => unknown }
      | undefined;
    server.registerTool = ((...args: unknown[]) => {
      captured = {
        config: args[1] as Record<string, unknown>,
        cb: args[2] as (...a: unknown[]) => unknown,
      };
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;
    const wrapped = withAnnotations(server, mockLogger, "readwrite");
    // Real tool name so ANNOTATION_MAP + OUTPUT_SCHEMA_MAP entries exist.
    (wrapped.tool as (...a: unknown[]) => unknown)(name, "fake", {}, handler);
    if (!captured) throw new Error("tool was not registered");
    return captured;
  }

  it("schema-violating payload → isError envelope with drift message, no structuredContent", async () => {
    const { cb } = registerFake("tm1_list_cubes", () =>
      mkResult({ totally: "wrong shape" }),
    );
    const result = (await cb()) as {
      isError?: boolean;
      structuredContent?: unknown;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as { message: string };
    expect(payload.message).toContain("output schema drift in tm1_list_cubes");
  });

  it("schema-conforming payload → structuredContent attached, no isError", async () => {
    const good = {
      total: 1,
      count: 1,
      offset: 0,
      has_more: false,
      next_offset: null,
      items: [{ name: "Cube_Sales" }],
    };
    const { cb } = registerFake("tm1_list_cubes", () => mkResult(good));
    const result = (await cb()) as {
      isError?: boolean;
      structuredContent?: unknown;
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(good);
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
