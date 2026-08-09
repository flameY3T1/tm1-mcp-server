import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pino from "pino";
import { startHttpTransport } from "../../src/http-transport.js";
import { SubscriptionRegistry } from "../../src/resources/subscriptions.js";
import { tm1Events } from "../../src/lib/tm1-events.js";
import type { TM1Config } from "../../src/config.js";

// Grab a free ephemeral port by binding :0, reading it back, then releasing.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function makeConfig(port: number, token?: string): TM1Config {
  return {
    baseUrl: "http://localhost:9999",
    user: "admin",
    password: "",
    ssl: { rejectUnauthorized: false },
    keepAliveIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    logLevel: "error",
    tm1Version: "11.8",
    transport: "http",
    httpHost: "127.0.0.1",
    httpPort: port,
    httpAllowedOrigins: [],
    httpToken: token,
    mode: "readonly",
    responseMode: "legacy",
    version: 11,
  };
}

// Minimal MCP server — no TM1 client needed. initialize is answered by the SDK.
// Shaped like the real src/index.ts builder: {server, dispose}. The transport
// owns calling dispose() on teardown, so the seam has to exist in the fake too.
function buildServer(): { server: McpServer; dispose: () => void } {
  return {
    server: new McpServer(
      { name: "test-server", version: "0.0.0" },
      { capabilities: { logging: {} } },
    ),
    dispose: () => {},
  };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

const silentLogger = pino({ level: "silent" });

describe("startHttpTransport (stateless, per-request)", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (close) await close();
    close = null;
  });

  function post(
    port: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("answers multiple sequential requests without a 500 on the second (H1 regression)", async () => {
    const port = await freePort();
    close = await startHttpTransport(
      buildServer,
      makeConfig(port),
      silentLogger,
    );

    const r1 = await post(port, INIT);
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(b1.result.serverInfo.name).toBe("test-server");

    // Shared-transport bug returned 500 here ("Stateless transport cannot be
    // reused across requests"). Each request must get a fresh transport.
    const r2 = await post(port, INIT);
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(b2.result.serverInfo.name).toBe("test-server");

    const r3 = await post(port, INIT);
    expect(r3.status).toBe(200);
  });

  // K1 regression. The stateless transport builds a fresh McpServer per request,
  // and buildMcpServer attaches a SubscriptionRegistry listener to the
  // PROCESS-GLOBAL tm1Events emitter. server.close() cannot detach that — it
  // knows nothing about tm1Events — so before the fix every request left one
  // listener (and the server graph it retained) behind: an unbounded leak that
  // also fanned every TM1 mutation out across all historical registries.
  //
  // Asserting on listenerCount rather than on "dispose was called" is deliberate:
  // it fails if the wiring is right but the disposer is a no-op.
  it("leaves no tm1Events listener behind after each request (K1 regression)", async () => {
    const port = await freePort();
    const before = tm1Events.listenerCount("mutation");

    close = await startHttpTransport(
      () => {
        const server = new McpServer(
          { name: "test-server", version: "0.0.0" },
          { capabilities: { logging: {}, resources: { subscribe: true } } },
        );
        const subscriptions = new SubscriptionRegistry(server, silentLogger);
        subscriptions.install();
        return { server, dispose: () => subscriptions.dispose() };
      },
      makeConfig(port),
      silentLogger,
    );

    for (let i = 0; i < 3; i++) {
      const res = await post(port, INIT);
      expect(res.status).toBe(200);
    }

    // res.on("close") fires after the body is flushed; give the loop one turn.
    await new Promise((r) => setImmediate(r));

    expect(tm1Events.listenerCount("mutation")).toBe(before);
  });

  it("rejects a request with a missing/wrong bearer token", async () => {
    const port = await freePort();
    close = await startHttpTransport(
      buildServer,
      makeConfig(port, "s3cret"),
      silentLogger,
    );

    const noAuth = await post(port, INIT);
    expect(noAuth.status).toBe(401);

    const wrong = await post(port, INIT, { Authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);

    const ok = await post(port, INIT, { Authorization: "Bearer s3cret" });
    expect(ok.status).toBe(200);
  });

  it("returns 404 for non-/mcp paths", async () => {
    const port = await freePort();
    close = await startHttpTransport(
      buildServer,
      makeConfig(port),
      silentLogger,
    );

    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("does not route /mcp-prefixed siblings like /mcpFoo (M3: exact-path match)", async () => {
    const port = await freePort();
    close = await startHttpTransport(
      buildServer,
      makeConfig(port),
      silentLogger,
    );

    // Loose startsWith("/mcp") would have routed these into the transport.
    const foo = await fetch(`http://127.0.0.1:${port}/mcpFoo`, {
      method: "POST",
      body: "{}",
    });
    expect(foo.status).toBe(404);

    const bar = await fetch(`http://127.0.0.1:${port}/mcp-extra`, {
      method: "POST",
      body: "{}",
    });
    expect(bar.status).toBe(404);
  });

  it("still routes exact /mcp with a query string", async () => {
    const port = await freePort();
    close = await startHttpTransport(
      buildServer,
      makeConfig(port),
      silentLogger,
    );

    const res = await fetch(`http://127.0.0.1:${port}/mcp?x=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INIT),
    });
    expect(res.status).toBe(200);
  });
});
