import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type pino from "pino";
import { withAnnotations } from "../../src/tools/with-annotations.js";
import { registerAllTools } from "../../src/tools/index.js";
import { TM1Client } from "../../src/tm1-client.js";
import type { SessionManager } from "../../src/session-manager.js";
import { baseTestConfig } from "../helpers/tm1-config.js";

const logger = {
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

const SANDBOX_TOOLS = [
  "tm1_compare_sandbox",
  "tm1_create_sandbox",
  "tm1_delete_sandbox",
  "tm1_discard_sandbox",
  "tm1_list_sandboxes",
  "tm1_publish_sandbox",
];

// Stands in for TM1Client: the gates read only these two fields.
const fakeClient = (sandboxingDisabled: boolean | undefined) =>
  ({ version: 11, sandboxingDisabled }) as unknown as TM1Client;

async function connect(tm1Client: TM1Client) {
  const server = new McpServer({ name: "t", version: "0" });
  registerAllTools(withAnnotations(server, logger, "readwrite"), tm1Client);
  const client = new Client({ name: "c", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const sandboxTools = async () =>
    (await client.listTools()).tools
      .map((t) => t.name)
      .filter((n) => n.includes("sandbox"))
      .sort();
  return { client, sandboxTools };
}

describe("sandbox tools follow DisableSandboxing", () => {
  it("lists them while the server setting is unknown or off", async () => {
    for (const value of [undefined, false]) {
      const { sandboxTools } = await connect(fakeClient(value));
      expect(await sandboxTools()).toEqual(SANDBOX_TOOLS);
    }
  });

  it("hides them once TM1 reports it disabled, and a call says why", async () => {
    const tm1Client = fakeClient(undefined);
    const { client, sandboxTools } = await connect(tm1Client);

    tm1Client.sandboxingDisabled = true;
    expect(await sandboxTools()).toEqual([]);
    // Other tools are untouched.
    expect((await client.listTools()).tools.length).toBeGreaterThan(50);

    // A client that kept the old list still gets a reason, not a bare refusal.
    const res = await client.callTool({
      name: "tm1_list_sandboxes",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text;
    expect(text).toContain("tm1_list_sandboxes is not available");
    expect(text).toContain("DisableSandboxing=T");
    expect(text).toContain("UNSUPPORTED_OPERATION");
    expect(text).not.toContain("server version");

    tm1Client.sandboxingDisabled = false;
    expect(await sandboxTools()).toEqual(SANDBOX_TOOLS);
  });

  it("covers a server built after TM1 reported it disabled (HTTP)", async () => {
    const { sandboxTools } = await connect(fakeClient(true));
    expect(await sandboxTools()).toEqual([]);
  });
});

describe("TM1Client reads DisableSandboxing after each login", () => {
  const build = (mode: "readwrite" | "sandbox" = "readwrite") => {
    const session = {} as SessionManager;
    const tm1Client = new TM1Client(
      { ...baseTestConfig, mode },
      session,
      logger,
    );
    return { session, tm1Client };
  };

  it("stores the value and reports the change once", async () => {
    const { session, tm1Client } = build();
    const read = vi
      .spyOn(tm1Client.server, "isSandboxingDisabled")
      .mockResolvedValue(true);
    const changed = vi.fn();
    tm1Client.onSandboxingChange = changed;

    expect(tm1Client.sandboxingDisabled).toBeUndefined();
    session.onLogin?.();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(tm1Client.sandboxingDisabled).toBe(true);

    session.onLogin?.();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps the tools visible when the setting cannot be read", async () => {
    const { session, tm1Client } = build();
    const read = vi
      .spyOn(tm1Client.server, "isSandboxingDisabled")
      .mockRejectedValue(new Error("no read rights"));
    const changed = vi.fn();
    tm1Client.onSandboxingChange = changed;
    session.onLogin?.();
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    await Promise.resolve();
    expect(tm1Client.sandboxingDisabled).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
  });

  it("warns when TM1_MODE=sandbox meets a server without sandboxing", async () => {
    const { session, tm1Client } = build("sandbox");
    vi.spyOn(tm1Client.server, "isSandboxingDisabled").mockResolvedValue(true);
    vi.mocked(logger.warn).mockClear();
    session.onLogin?.();
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("TM1_MODE=sandbox cannot write"),
      ),
    );
  });
});
