// Starts the real entry point (src/index.ts) as a child process against local
// fakes on 127.0.0.1. main() runs on import, so the startup order and the
// per-transport capabilities cannot be reached by importing the module.
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const REQUEST_TIMEOUT_MS = 20000;

interface RpcMessage {
  id?: number;
  result?: {
    capabilities?: { resources?: { subscribe?: boolean } };
  };
  error?: { code: number };
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function listen(server: net.Server): Promise<number> {
  cleanup.push(() => {
    if (server instanceof http.Server) server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as net.AddressInfo).port),
    ),
  );
}

// Every key the repo .env could define is set here, so dotenv (which never
// overwrites) cannot point this process at a real TM1.
function start(tm1Port: number, extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
    env: {
      PATH: process.env.PATH,
      TM1_BASE_URL: `http://127.0.0.1:${tm1Port}`,
      TM1_USER: "fake",
      TM1_PASSWORD: "fake",
      TM1_VERSION: "11.8",
      TM1_SSL_REJECT_UNAUTHORIZED: "false",
      TM1_KEEP_ALIVE_INTERVAL: "200",
      TM1_REQUEST_TIMEOUT: String(REQUEST_TIMEOUT_MS),
      TM1_LOG_LEVEL: "error",
      TM1_MODE: "readonly",
      TM1_LOCAL_FILE_ROOT: fileURLToPath(new URL(".", import.meta.url)),
      ...extra,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  cleanup.push(() => child.kill("SIGKILL"));
  return child;
}

function stdioClient(child: ChildProcess) {
  const waiters = new Map<number, (m: RpcMessage) => void>();
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line) as RpcMessage;
      if (message.id !== undefined) waiters.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  const send = (message: object) =>
    child.stdin!.write(JSON.stringify(message) + "\n");
  const call = (method: string, params: object): Promise<RpcMessage> => {
    const id = ++nextId;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => waiters.set(id, resolve));
  };
  return {
    call,
    initialize: async () => {
      const response = await call("initialize", INIT_PARAMS);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return response;
    },
  };
}

const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "startup-test", version: "0" },
};

describe("process startup", () => {
  it("answers initialize while TM1 stays silent", async () => {
    // Accepts the connection and never answers: the login stays open.
    const tm1Port = await listen(net.createServer(() => {}));
    const client = stdioClient(start(tm1Port));

    const startedAt = Date.now();
    const response = await client.initialize();

    expect(Date.now() - startedAt).toBeLessThan(REQUEST_TIMEOUT_MS / 2);
    expect(response.result?.capabilities?.resources?.subscribe).toBe(true);
  }, 30000);

  it("runs keep-alive for a session that a tool call opened after a failed first login", async () => {
    const urls: string[] = [];
    let requests = 0;
    const tm1Port = await listen(
      http.createServer((req, res) => {
        requests++;
        urls.push(req.url ?? "");
        if (requests === 1) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "TM1SessionId=fakesession; Path=/",
        });
        res.end(JSON.stringify({ value: [] }));
      }),
    );
    const client = stdioClient(start(tm1Port));
    await client.initialize();
    while (requests === 0) await sleep(20);

    await client.call("tools/call", { name: "tm1_list_cubes", arguments: {} });
    const seen = urls.length;
    while (!urls.slice(seen).some((u) => u.includes("ActiveSession"))) {
      await sleep(20);
    }
  }, 30000);

  it("does not offer resource subscriptions over stateless HTTP", async () => {
    const tm1Port = await listen(net.createServer(() => {}));
    const probe = net.createServer();
    const mcpPort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    start(tm1Port, {
      TM1_MCP_TRANSPORT: "http",
      TM1_MCP_HTTP_PORT: String(mcpPort),
    });

    const post = async (body: object): Promise<RpcMessage> => {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
      return (await response.json()) as RpcMessage;
    };
    const postWhenUp = async (body: object): Promise<RpcMessage> => {
      for (;;) {
        try {
          return await post(body);
        } catch {
          await sleep(50);
        }
      }
    };

    const init = await postWhenUp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: INIT_PARAMS,
    });
    const subscribe = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/subscribe",
      params: { uri: "tm1://server/state" },
    });

    expect(init.result?.capabilities?.resources?.subscribe).toBe(false);
    expect(subscribe.error?.code).toBe(-32601);
  }, 30000);
});
