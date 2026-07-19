// Live test harness — drives the REAL MCP tool layer against a running TM1
// server, exactly as an MCP client would: each call goes through the tool's
// zod input schema (defaults + validation), the withAnnotations wrapper
// (annotation injection, error normalization, outputSchema attach), and the
// real handler → real TM1Client → real OData. This is end-to-end coverage of
// the tool surface, not unit mocks.
//
// Opt-in: requires TM1_BASE_URL + TM1_USER in the environment (loaded from
// .env via dotenv). When absent, LIVE_ENABLED is false and suites skip.
//
// Everything this harness creates lives under the SANDBOX prefix so a stray
// run can never touch real model objects, and sweepSandbox() removes leftovers.
import "dotenv/config";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type TM1Config } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerAllTools } from "../../src/tools/index.js";
import type { McpToolResult } from "../../src/tools/error-format.js";

/** True only when the environment is configured to reach a live TM1 server. */
export const LIVE_ENABLED = Boolean(
  process.env.TM1_BASE_URL && process.env.TM1_USER,
);

/** All objects this harness creates are prefixed with this. Never collides
 *  with real model objects; sweepSandbox() keys off it. */
export const SANDBOX = "ZZ_MCP_LIVE";

/** Result of a single tool invocation, normalized for assertions. */
export interface CallResult {
  /** Raw MCP tool result (content[], isError, structuredContent, …). */
  result: McpToolResult;
  /** Parsed JSON from the first text block, if it was JSON. */
  json: any;
  /** Raw first text block. */
  text: string | undefined;
  /** True when the tool returned an error envelope (handler threw or isError). */
  isError: boolean;
}

interface ToolEntry {
  inputSchema: ZodRawShape;
  handler: (...args: unknown[]) => Promise<McpToolResult>;
}

export interface LiveHarness {
  client: TM1Client;
  /** Invoke a tool by name with raw args, as an MCP client would. */
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Like call(), but throws if the tool returned an error envelope. */
  ok: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Names of all registered (readwrite-mode) tools. */
  toolNames: () => string[];
}

let harnessPromise: Promise<LiveHarness> | null = null;

// Minimal RequestHandlerExtra stand-in. Tool handlers destructure only their
// args object and ignore `extra`, so a stub satisfies the call signature.
const mockExtra = {
  signal: new AbortController().signal,
  requestId: "live-harness",
  sendNotification: async () => undefined,
  sendRequest: async () => undefined,
};

/**
 * Connect once, register every tool in readwrite mode (so destructive tools
 * are available for lifecycle teardown), and return a shared harness. Safe to
 * call from multiple beforeAll hooks — the connection is memoized.
 */
export function getHarness(): Promise<LiveHarness> {
  harnessPromise ??= build();
  return harnessPromise;
}

async function build(): Promise<LiveHarness> {
  const baseConfig = loadConfig();
  // Force readwrite: lifecycle suites must create AND delete sandbox objects.
  const config: TM1Config = { ...baseConfig, mode: "readwrite" };
  const logger = createLogger({ logLevel: "error" });
  const sessionManager = new SessionManager(config, logger);
  const client = new TM1Client(config, sessionManager, logger);
  await client.connect();

  // Fake McpServer: capture the fully-wrapped (annotation + error-normalized)
  // handlers that withAnnotations registers via registerTool.
  const registry = new Map<string, ToolEntry>();
  const fakeServer = {
    registerTool(
      name: string,
      cfg: { inputSchema?: ZodRawShape },
      cb: (...args: unknown[]) => Promise<McpToolResult>,
    ) {
      registry.set(name, { inputSchema: cfg.inputSchema ?? {}, handler: cb });
    },
    // wrapCb references server.server.sendLoggingMessage for slow-tool warnings.
    server: { sendLoggingMessage: async () => undefined },
  } as unknown as McpServer;

  registerAllTools(withAnnotations(fakeServer, logger, "readwrite"), client);

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallResult> => {
    const entry = registry.get(name);
    if (!entry) {
      throw new Error(
        `Tool not registered: ${name} (typo, or missing from ANNOTATION_MAP?)`,
      );
    }
    // Parse through the tool's own schema — applies defaults and validation
    // exactly as the MCP SDK does before dispatching to the handler.
    const parsed = z.object(entry.inputSchema).parse(args);
    const result = await entry.handler(parsed, mockExtra);
    const first = result?.content?.[0];
    const text =
      first && first.type === "text" && typeof first.text === "string"
        ? first.text
        : undefined;
    let json: unknown;
    if (text) {
      const t = text.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          json = JSON.parse(t);
        } catch {
          /* non-JSON text result (e.g. table format) */
        }
      }
    }
    return { result, json, text, isError: Boolean(result?.isError) };
  };

  const ok = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallResult> => {
    const r = await call(name, args);
    if (r.isError) {
      throw new Error(
        `Expected ${name} to succeed but got error: ${r.text ?? "(no body)"}`,
      );
    }
    return r;
  };

  return { client, call, ok, toolNames: () => [...registry.keys()] };
}

/**
 * Best-effort teardown: delete any sandbox-prefixed objects left behind by a
 * crashed or interrupted suite. Idempotent — missing objects are ignored.
 * Call from a global afterAll or the last suite.
 */
export async function sweepSandbox(h: LiveHarness): Promise<void> {
  const swallow = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch {
      /* already gone */
    }
  };

  // Deletion order follows dependencies: chores reference processes; cubes
  // reference dimensions (and own their views). Delete dependents first so a
  // bound object never blocks its dependency's removal.

  // 1. Chores (free the processes they bind).
  const chores = await h.call("tm1_list_chores", { fetchAll: true });
  for (const c of chores.json?.items ?? []) {
    const name = typeof c === "string" ? c : c?.name;
    if (typeof name === "string" && name.startsWith(SANDBOX)) {
      await swallow(h.call("tm1_delete_chore", { choreName: name, confirm: name }));
    }
  }

  // 2. Processes.
  const procs = await h.call("tm1_list_processes", {
    fetchAll: true,
    nameContains: SANDBOX,
  });
  for (const p of procs.json?.items ?? []) {
    const name = typeof p === "string" ? p : p?.name;
    if (typeof name === "string" && name.startsWith(SANDBOX)) {
      await swallow(
        h.call("tm1_delete_process", { processName: name, confirm: name }),
      );
    }
  }

  // 3. Cubes (drops their views with them; frees the dimensions). includeControl
  // so sandbox control cubes (}ElementAttributes_…, }Views_…) are caught too;
  // match by `includes` since control names carry the prefix mid-string.
  const cubes = await h.call("tm1_list_cubes", {
    fetchAll: true,
    includeControl: true,
  });
  for (const c of cubes.json?.items ?? []) {
    if (typeof c?.name === "string" && c.name.includes(SANDBOX)) {
      await swallow(h.call("tm1_delete_cube", { cubeName: c.name, confirm: c.name }));
    }
  }

  // 4. Dimensions (now unreferenced). list_dimensions has no nameContains
  // filter — fetch all and match the prefix client-side. Two passes: base
  // dimensions first, then sandbox control dimensions (}Subsets_… lingers
  // after its base dim on TM1 11.8 and is skipped by a startsWith filter).
  const dims = await h.call("tm1_list_dimensions", {
    fetchAll: true,
    includeControl: true,
  });
  const dimNames = (dims.json?.items ?? [])
    .map((d: unknown) => (typeof d === "string" ? d : (d as { name?: string })?.name))
    .filter((n: unknown): n is string => typeof n === "string" && n.includes(SANDBOX));
  for (const name of dimNames.filter((n: string) => !n.startsWith("}"))) {
    await swallow(h.call("tm1_delete_dimension", { dimensionName: name, confirm: name }));
  }
  for (const name of dimNames.filter((n: string) => n.startsWith("}"))) {
    await swallow(h.call("tm1_delete_dimension", { dimensionName: name, confirm: name }));
  }
}
