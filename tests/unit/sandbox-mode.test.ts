// TM1_MODE=sandbox: the read tools plus the sandbox-scoped writing tools, and
// those write only into sandboxes named with TM1_SANDBOX_PREFIX.
//
// What this suite pins:
//   - config parses the mode and the prefix, and refuses an empty prefix;
//   - the policy refuses base data and foreign sandboxes in sandbox mode, and
//     leaves readwrite unchanged;
//   - registration in sandbox mode is exactly "read-only + sandboxScoped" —
//     no other writing tool, and no tm1_publish_sandbox;
//   - tm1_write_cells sends nothing when the target is not allowed, threads
//     the sandbox through, and cannot be steered to Base or another sandbox
//     through the Sandboxes dimension;
//   - every request of a sandboxed write and read carries `!sandbox=`;
//   - compare matches cells by coordinate, not by ordinal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type pino from "pino";
import { loadConfig } from "../../src/config.js";
import {
  cleanSandboxName,
  requireManagedSandbox,
  resolveWriteSandbox,
  withSandboxParam,
  type SandboxPolicyContext,
} from "../../src/lib/sandbox-policy.js";
import { registerAllTools } from "../../src/tools/index.js";
import { allSpecs } from "../../src/tools/define-tool.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerWriteCells } from "../../src/tools/celldata/write-cells.js";
import {
  cellsByCoordinate,
  diffCells,
} from "../../src/tools/sandboxes/compare-sandbox.js";
import { CellService } from "../../src/tm1-client/services/cell-service.js";
import { SandboxService } from "../../src/tm1-client/services/sandbox-service.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { MdxResult } from "../../src/types.js";

const SANDBOX: SandboxPolicyContext = {
  mode: "sandbox",
  sandboxPrefix: "mcp-",
};
const READWRITE: SandboxPolicyContext = {
  mode: "readwrite",
  sandboxPrefix: "mcp-",
};

describe("config — TM1_MODE=sandbox", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TM1_")) delete process.env[key];
    });
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "secret";
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses the mode case-insensitively, with the default prefix", () => {
    process.env.TM1_MODE = "Sandbox";
    const config = loadConfig();
    expect(config.mode).toBe("sandbox");
    expect(config.sandboxPrefix).toBe("mcp-");
  });

  it("takes TM1_SANDBOX_PREFIX", () => {
    process.env.TM1_SANDBOX_PREFIX = "agent_";
    expect(loadConfig().sandboxPrefix).toBe("agent_");
  });

  it.each(["", "   ", "a b", "x'y"])(
    "refuses the prefix %j — it is what keeps the server off other sandboxes",
    (prefix) => {
      process.env.TM1_SANDBOX_PREFIX = prefix;
      expect(() => loadConfig()).toThrow(/Invalid TM1_SANDBOX_PREFIX/);
    },
  );

  it("names sandbox among the valid modes", () => {
    process.env.TM1_MODE = "sandboxed";
    expect(() => loadConfig()).toThrow(/"readwrite", "sandbox" or "readonly"/);
  });
});

describe("sandbox policy", () => {
  it("refuses base data in sandbox mode", () => {
    expect(() => resolveWriteSandbox(SANDBOX, undefined)).toThrow(
      /must name a sandbox/,
    );
    expect(() => resolveWriteSandbox(SANDBOX, "  ")).toThrow(
      /must name a sandbox/,
    );
  });

  it("refuses a sandbox without the prefix in sandbox mode", () => {
    expect(() => resolveWriteSandbox(SANDBOX, "Proposal-1")).toThrow(
      /does not start with "mcp-"/,
    );
    expect(() => requireManagedSandbox(SANDBOX, "Proposal-1")).toThrow();
  });

  it("matches the prefix case-insensitively, as TM1 names are", () => {
    expect(resolveWriteSandbox(SANDBOX, " MCP-whatif ")).toBe("MCP-whatif");
  });

  it("leaves readwrite as it was: base data or any sandbox", () => {
    expect(resolveWriteSandbox(READWRITE, undefined)).toBeUndefined();
    expect(resolveWriteSandbox(READWRITE, "Proposal-1")).toBe("Proposal-1");
    expect(() => requireManagedSandbox(READWRITE, "Proposal-1")).not.toThrow();
  });

  it("refuses control characters in a sandbox name", () => {
    expect(() => cleanSandboxName("mcp-a\nb")).toThrow(/control character/);
  });

  it("appends !sandbox with the right separator, URL-encoded", () => {
    expect(withSandboxParam("/api/v1/ExecuteMDX", "mcp-a b")).toBe(
      "/api/v1/ExecuteMDX?!sandbox=mcp-a%20b",
    );
    expect(withSandboxParam("/api/v1/ExecuteMDX?$expand=Cells", "mcp-x")).toBe(
      "/api/v1/ExecuteMDX?$expand=Cells&!sandbox=mcp-x",
    );
    expect(withSandboxParam("/api/v1/ExecuteMDX", undefined)).toBe(
      "/api/v1/ExecuteMDX",
    );
  });
});

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

function registeredIn(mode: "readwrite" | "sandbox" | "readonly"): Set<string> {
  const names = new Set<string>();
  for (const version of [11, 12] as const) {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    server.registerTool = ((...args: unknown[]) => {
      names.add(args[0] as string);
      return {} as ReturnType<typeof server.registerTool>;
    }) as typeof server.registerTool;
    registerAllTools(withAnnotations(server, mockLogger, mode), {
      version,
    } as unknown as TM1Client);
  }
  return names;
}

describe("registration in sandbox mode", () => {
  const sandbox = registeredIn("sandbox");
  const readonly = registeredIn("readonly");
  const readwrite = registeredIn("readwrite");

  it("is exactly the read-only set plus the sandboxScoped tools", () => {
    const scoped = [...allSpecs().values()]
      .filter((s) => s.sandboxScoped)
      .map((s) => s.name)
      .sort();
    expect(scoped).toEqual([
      "tm1_create_sandbox",
      "tm1_delete_sandbox",
      "tm1_discard_sandbox",
      "tm1_write_cells",
    ]);
    expect([...sandbox].sort()).toEqual([...readonly, ...scoped].sort());
  });

  it("leaves publishing to readwrite", () => {
    expect(sandbox.has("tm1_publish_sandbox")).toBe(false);
    expect(readwrite.has("tm1_publish_sandbox")).toBe(true);
  });

  it("registers no sandbox write tool in readonly mode", () => {
    expect(readonly.has("tm1_write_cells")).toBe(false);
    expect(readonly.has("tm1_create_sandbox")).toBe(false);
    expect(readonly.has("tm1_list_sandboxes")).toBe(true);
    expect(readonly.has("tm1_compare_sandbox")).toBe(true);
  });
});

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function writeCellsHandler(
  ctx: SandboxPolicyContext,
  cubeDims: string[],
): { handler: ToolHandler; writeCells: ReturnType<typeof vi.fn> } {
  let captured: ToolHandler | null = null;
  let parser: z.ZodObject<ZodRawShape> | null = null;
  const server = {
    tool: (_n: string, _d: string, schema: ZodRawShape, h: ToolHandler) => {
      parser = z.object(schema);
      captured = h;
    },
  } as unknown as Parameters<typeof registerWriteCells>[0];
  const writeCells = vi.fn(async () => undefined);
  const client = {
    ...ctx,
    elements: { consolidatedAmong: async () => [] },
    cells: { writeCells },
    cubes: { getDimensionNames: async () => cubeDims },
  } as unknown as TM1Client;
  registerWriteCells(server, client);
  const p = parser!;
  const h = captured!;
  return { handler: (args) => h(p.parse(args)), writeCells };
}

const CUBE = ["Region", "Month"];
const ARGS = {
  cubeName: "Sales",
  dimensions: CUBE,
  cells: [{ elements: ["Berlin", "Jan"], value: 42 }],
  confirm: "Sales",
};

describe("tm1_write_cells in sandbox mode", () => {
  it("sends nothing without a sandbox", async () => {
    const { handler, writeCells } = writeCellsHandler(SANDBOX, CUBE);
    await expect(handler(ARGS)).rejects.toThrow(/must name a sandbox/);
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("sends nothing into a sandbox without the prefix", async () => {
    const { handler, writeCells } = writeCellsHandler(SANDBOX, CUBE);
    await expect(handler({ ...ARGS, sandbox: "Proposal-1" })).rejects.toThrow(
      /does not start with/,
    );
    expect(writeCells).not.toHaveBeenCalled();
  });

  it("writes into the named sandbox", async () => {
    const { handler, writeCells } = writeCellsHandler(SANDBOX, CUBE);
    const res = await handler({ ...ARGS, sandbox: "mcp-whatif" });
    expect(writeCells).toHaveBeenCalledWith(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 42 }],
      "mcp-whatif",
    );
    expect(JSON.stringify(res)).toContain('"sandbox":"mcp-whatif"');
  });

  it("binds a left-out Sandboxes dimension to the sandbox, not Base", async () => {
    const dims = [...CUBE, "Sandboxes"];
    const { handler, writeCells } = writeCellsHandler(SANDBOX, dims);
    await handler({ ...ARGS, sandbox: "mcp-whatif" });
    expect(writeCells).toHaveBeenCalledWith(
      "Sales",
      dims,
      [{ elements: ["Berlin", "Jan", "mcp-whatif"], value: 42 }],
      "mcp-whatif",
    );
  });

  it.each(["Base", "Proposal-1"])(
    "cannot reach Sandboxes:%s through the coordinate",
    async (other) => {
      const dims = [...CUBE, "Sandboxes"];
      const { handler, writeCells } = writeCellsHandler(SANDBOX, dims);
      await expect(
        handler({
          ...ARGS,
          dimensions: dims,
          cells: [{ elements: ["Berlin", "Jan", other], value: 42 }],
          sandbox: "mcp-whatif",
        }),
      ).rejects.toThrow(/targets sandbox "mcp-whatif"/);
      expect(writeCells).not.toHaveBeenCalled();
    },
  );

  it("still writes base data in readwrite mode", async () => {
    const { handler, writeCells } = writeCellsHandler(READWRITE, CUBE);
    await handler(ARGS);
    expect(writeCells).toHaveBeenCalledWith(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 42 }],
      undefined,
    );
  });
});

function recordingHttp(reply: (method: string, path: string) => unknown) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const http = {
    request: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return reply(method, path);
    }),
  } as unknown as TM1HttpClient;
  return { http, calls };
}

describe("requests carry !sandbox", () => {
  it("on every request of a sandboxed write", async () => {
    const { http, calls } = recordingHttp((_m, path) =>
      path.startsWith("/api/v1/ExecuteMDX") ? { ID: "cs0" } : undefined,
    );
    await new CellService(http).writeCells(
      "Sales",
      CUBE,
      [{ elements: ["Berlin", "Jan"], value: 1 }],
      "mcp-whatif",
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/v1/ExecuteMDX?!sandbox=mcp-whatif",
      "PATCH /api/v1/Cellsets('cs0')/Cells?!sandbox=mcp-whatif",
      "DELETE /api/v1/Cellsets('cs0')?!sandbox=mcp-whatif",
    ]);
  });

  it("on a sandboxed MDX read", async () => {
    const { http, calls } = recordingHttp((method) =>
      method === "POST" ? { ID: "cs0", Cells: [], Axes: [] } : undefined,
    );
    await new CellService(http).executeMdx(
      "SELECT {} ON 0 FROM [Sales]",
      10,
      0,
      undefined,
      "mcp-whatif",
    );
    expect(calls[0]?.path).toMatch(
      /^\/api\/v1\/ExecuteMDX\?\$expand=.*&!sandbox=mcp-whatif$/,
    );
  });

  it("not on a base write", async () => {
    const { http, calls } = recordingHttp((_m, path) =>
      path.startsWith("/api/v1/ExecuteMDX") ? { ID: "cs0" } : undefined,
    );
    await new CellService(http).writeCells("Sales", CUBE, [
      { elements: ["Berlin", "Jan"], value: 1 },
    ]);
    expect(calls.every((c) => !c.path.includes("!sandbox"))).toBe(true);
  });
});

describe("SandboxService", () => {
  it("addresses the sandbox endpoints", async () => {
    const { http, calls } = recordingHttp((method) =>
      method === "GET"
        ? { value: [{ Name: "mcp-a", IsLoaded: true }] }
        : undefined,
    );
    const svc = new SandboxService(http);
    expect(await svc.list()).toEqual([
      {
        name: "mcp-a",
        includeInSandboxDimension: null,
        isActive: null,
        isLoaded: true,
        isQueued: null,
      },
    ]);
    await svc.create("mcp-a");
    await svc.discardChanges("mcp-a");
    await svc.publish("mcp-a");
    await svc.delete("it's");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/v1/Sandboxes",
      "POST /api/v1/Sandboxes",
      "POST /api/v1/Sandboxes('mcp-a')/tm1.DiscardChanges",
      "POST /api/v1/Sandboxes('mcp-a')/tm1.Publish",
      "DELETE /api/v1/Sandboxes('it''s')",
    ]);
    expect(calls[1]?.body).toEqual({
      Name: "mcp-a",
      IncludeInSandboxDimension: true,
    });
  });
});

function cellset(rows: string[], values: Array<number | null>): MdxResult {
  return {
    totalCellCount: values.length,
    cells: values.map((value) => ({ value, formattedValue: "" })),
    axes: [
      {
        tuples: rows.map((name) => ({
          members: [{ name, hierarchyName: "Region" }],
        })),
      },
    ],
  };
}

describe("compare matches cells by coordinate", () => {
  it("lists only the cells that differ, with the change", () => {
    const base = cellsByCoordinate(cellset(["Berlin", "Paris"], [10, 20]));
    const sand = cellsByCoordinate(cellset(["Berlin", "Paris"], [15, 20]));
    expect(diffCells(base, sand)).toEqual([
      { coordinates: ["Region:Berlin"], base: 10, sandbox: 15, change: 5 },
    ]);
  });

  it("stays right when NON EMPTY gives the sides different axes", () => {
    // Base has Berlin only; the sandbox wrote Paris, so its NON EMPTY axis
    // has two tuples and Berlin moved to ordinal 1. Ordinal matching would
    // report Berlin as changed.
    const base = cellsByCoordinate(cellset(["Berlin"], [10]));
    const sand = cellsByCoordinate(cellset(["Paris", "Berlin"], [7, 10]));
    expect(diffCells(base, sand)).toEqual([
      { coordinates: ["Region:Paris"], base: null, sandbox: 7, change: 7 },
    ]);
  });

  it("treats empty, zero and null as the same", () => {
    const base = cellsByCoordinate(cellset(["Berlin"], [null]));
    const sand = cellsByCoordinate(cellset(["Berlin"], [0]));
    expect(diffCells(base, sand)).toEqual([]);
  });
});
