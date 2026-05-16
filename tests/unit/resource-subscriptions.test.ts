import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SubscriptionRegistry } from "../../src/resources/subscriptions.js";
import { tm1Events } from "../../src/lib/tm1-events.js";

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
} as unknown as import("pino").Logger;

function makeServer(): {
  server: McpServer;
  sendResourceUpdated: ReturnType<typeof vi.fn>;
  handlers: Map<unknown, (req: unknown) => Promise<unknown>>;
} {
  const handlers = new Map<unknown, (req: unknown) => Promise<unknown>>();
  const sendResourceUpdated = vi.fn().mockResolvedValue(undefined);

  const fakeLowLevel = {
    setRequestHandler: (schema: unknown, handler: (req: unknown) => Promise<unknown>) => {
      handlers.set(schema, handler);
    },
    sendResourceUpdated,
  };

  // Cast: McpServer.server is the underlying low-level Server. The registry
  // only touches setRequestHandler and sendResourceUpdated, both stubbed above.
  const server = { server: fakeLowLevel } as unknown as McpServer;

  return { server, sendResourceUpdated, handlers };
}

describe("R2-05: SubscriptionRegistry", () => {
  let registry: SubscriptionRegistry;
  let server: McpServer;
  let sendResourceUpdated: ReturnType<typeof vi.fn>;
  let handlers: Map<unknown, (req: unknown) => Promise<unknown>>;

  beforeEach(() => {
    ({ server, sendResourceUpdated, handlers } = makeServer());
    registry = new SubscriptionRegistry(server, mockLogger);
    registry.install();
  });

  afterEach(() => {
    registry.dispose();
    vi.restoreAllMocks();
  });

  it("registers subscribe and unsubscribe handlers", () => {
    expect(handlers.has(SubscribeRequestSchema)).toBe(true);
    expect(handlers.has(UnsubscribeRequestSchema)).toBe(true);
  });

  it("tracks subscribed URIs", async () => {
    const subscribe = handlers.get(SubscribeRequestSchema)!;
    await subscribe({ params: { uri: "tm1://server/state" } });

    expect(registry.isSubscribed("tm1://server/state")).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it("untracks on unsubscribe", async () => {
    const subscribe = handlers.get(SubscribeRequestSchema)!;
    const unsubscribe = handlers.get(UnsubscribeRequestSchema)!;
    await subscribe({ params: { uri: "tm1://server/state" } });
    await unsubscribe({ params: { uri: "tm1://server/state" } });

    expect(registry.isSubscribed("tm1://server/state")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("emits sendResourceUpdated for subscribed state URI on mutation", async () => {
    const subscribe = handlers.get(SubscribeRequestSchema)!;
    await subscribe({ params: { uri: "tm1://server/state" } });

    tm1Events.emit("mutation", { method: "POST", path: "/api/v1/Dimensions" });
    // Give the catch chain a tick to settle (sendResourceUpdated is async).
    await new Promise((r) => setImmediate(r));

    expect(sendResourceUpdated).toHaveBeenCalledOnce();
    expect(sendResourceUpdated).toHaveBeenCalledWith({ uri: "tm1://server/state" });
  });

  it("does not notify URIs the client hasn't subscribed to", () => {
    tm1Events.emit("mutation", { method: "DELETE", path: "/api/v1/Cubes('X')" });
    expect(sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("ignores subscribed URIs outside the state-sensitive set", async () => {
    const subscribe = handlers.get(SubscribeRequestSchema)!;
    await subscribe({ params: { uri: "tm1://process/Foo/code" } });

    tm1Events.emit("mutation", { method: "POST", path: "/api/v1/Processes" });
    await new Promise((r) => setImmediate(r));

    expect(sendResourceUpdated).not.toHaveBeenCalled();
  });

  it("detaches listener on dispose", () => {
    const before = tm1Events.listenerCount("mutation");
    registry.dispose();
    const after = tm1Events.listenerCount("mutation");
    expect(after).toBeLessThan(before);
  });

  it("survives sendResourceUpdated rejection (logs, no throw)", async () => {
    sendResourceUpdated.mockRejectedValueOnce(new Error("transport closed"));
    const subscribe = handlers.get(SubscribeRequestSchema)!;
    await subscribe({ params: { uri: "tm1://server/state" } });

    expect(() => {
      tm1Events.emit("mutation", { method: "PUT", path: "/api/v1/Cubes('Sales')" });
    }).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
