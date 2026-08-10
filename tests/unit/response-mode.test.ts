import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
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

// T1: every tool declares an outputSchema, and the proxy parses the handler's
// JSON text into structuredContent to satisfy it. In "legacy" mode the original
// text block stays, so the identical JSON crosses the wire twice — on every
// successful response, for all ~111 tools.
//
// Drive the wrapped callback directly rather than through a transport: the
// duplication lives in the proxy, and this keeps the assertion on the exact
// object the SDK would serialize.
type Cb = (...a: unknown[]) => Promise<unknown>;

// The shape a tool handler hands back before the proxy rewrites it. Typed
// (rather than `unknown`) so the `proxied.tool(...)` call below resolves
// against the SDK's CallToolResult overload instead of silently degrading.
type HandlerResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
};

// Minimal payload that satisfies ServerStateResultSchema's required keys — the
// proxy's drift guard runs before the wire shape is decided, so an abbreviated
// object would fail for the wrong reason.
const PAYLOAD = {
  connected: true,
  server: { version: "11.8" },
  capabilities: {},
  counts: { cubes: 0 },
};

// tm1_get_server_state has a permissive (.passthrough()) output schema, so the
// drift guard accepts an abbreviated payload and these tests stay about wire
// shape rather than that tool's contract.
function captureWrapped(
  responseMode?: "legacy" | "structured",
  result?: HandlerResult,
): Cb {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  let wrapped: Cb | undefined;
  server.registerTool = (...args: unknown[]) => {
    wrapped = args[2] as Cb;
    // Don't actually register — only the wrapped callback is under test.
    return undefined as unknown as ReturnType<typeof server.registerTool>;
  };

  const proxied =
    responseMode === undefined
      ? withAnnotations(server, mockLogger, "readwrite")
      : withAnnotations(server, mockLogger, "readwrite", responseMode);

  proxied.tool(
    "tm1_get_server_state",
    "desc",
    {},
    () =>
      result ?? {
        content: [{ type: "text" as const, text: JSON.stringify(PAYLOAD) }],
      },
  );

  if (!wrapped) throw new Error("callback was not wrapped");
  return wrapped;
}

describe("TM1_RESPONSE_MODE", () => {
  it("legacy ships the payload twice — text AND structuredContent", async () => {
    const res = (await captureWrapped("legacy")()) as {
      content: Array<{ text: string }>;
      structuredContent: unknown;
    };

    expect(res.structuredContent).toEqual(PAYLOAD);
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toBe(JSON.stringify(PAYLOAD));
  });

  it("structured drops the duplicate text block", async () => {
    const res = (await captureWrapped("structured")()) as {
      content: unknown[];
      structuredContent: unknown;
    };

    expect(res.structuredContent).toEqual(PAYLOAD);
    // Spec-legal only because an outputSchema is declared: CallToolResult
    // content "may be empty" in that case.
    expect(res.content).toEqual([]);
  });

  // The parameter default and the shipped default (config.ts) are both legacy.
  // Guarding it here catches a flip back to structured-by-default, which is the
  // change that silently blanks output on content-only clients.
  it("direct callers that omit the argument still get legacy", async () => {
    const res = (await captureWrapped()()) as { content: unknown[] };
    expect(res.content).toHaveLength(1);
  });

  it("leaves a non-JSON (markdown) text block alone in structured mode", async () => {
    // Markdown mode: the handler renders a table AND attaches structuredContent
    // itself. There the text is the point, not a duplicate — dropping it would
    // defeat format:"markdown".
    const res = (await captureWrapped("structured", {
      content: [{ type: "text" as const, text: "## State\n\n| a | b |" }],
      structuredContent: PAYLOAD,
    })()) as {
      content: Array<{ text: string }>;
      structuredContent: unknown;
    };

    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.text).toContain("## State");
    expect(res.structuredContent).toEqual(PAYLOAD);
  });
});
