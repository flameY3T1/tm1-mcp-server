import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllResources } from "../../src/resources/index.js";
import type { TM1Client } from "../../src/tm1-client.js";

// The MCP resource surface has no per-request parameters, so unlike the tool
// path (tm1_get_process_code with maskSecrets=false) there is no opt-out —
// credential redaction must be unconditional. These tests pin that contract
// by capturing the registered read callbacks and invoking them directly.

type ReadCb = (
  uri: URL,
  vars?: Record<string, string | string[]>,
) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>;

function makeFakeServer(): { server: McpServer; readCallbacks: Map<string, ReadCb> } {
  const readCallbacks = new Map<string, ReadCb>();
  const server = {
    registerResource: (name: string, _uriOrTemplate: unknown, _meta: unknown, cb: ReadCb) => {
      readCallbacks.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, readCallbacks };
}

const ODBC_PASSWORD = "Sup3rSecret!";

function makeTM1Stub(): TM1Client {
  return {
    processes: {
      getCode: async () => ({
        prolog: `ODBCOpen('MyDSN', 'sa', '${ODBC_PASSWORD}');`,
        metadata: "sPwd = 'hunter2';",
        data: "",
        epilog: "",
      }),
    },
    server: {
      getInfo: async () => ({
        serverName: "testserver",
        productVersion: "11.8.0",
        dataDirectory: "C:\\TM1\\Data",
        extra: { Access: { LDAP: { Password: "ldap-secret" } } },
      }),
    },
  } as unknown as TM1Client;
}

describe("MCP resources – unconditional credential masking", () => {
  it("tm1://process/{name}/code masks the ODBC password and credential assignments", async () => {
    const { server, readCallbacks } = makeFakeServer();
    registerAllResources(server, makeTM1Stub());

    const cb = readCallbacks.get("process-code");
    expect(cb).toBeDefined();
    const result = await cb!(new URL("tm1://process/My.Proc/code"), { name: "My.Proc" });
    const text = result.contents[0]!.text;
    const payload = JSON.parse(text) as Record<string, string>;

    // The credential literals never leave the server unmasked …
    expect(text).not.toContain(ODBC_PASSWORD);
    expect(text).not.toContain("hunter2");
    expect(payload.prolog).toContain("'***'");
    expect(payload.metadata).toContain("'***'");
    // … while the non-secret parts of the call survive intact.
    expect(payload.prolog).toContain("ODBCOpen('MyDSN', 'sa'");
  });

  it("tm1://server/info projects identity fields and drops the raw config body", async () => {
    const { server, readCallbacks } = makeFakeServer();
    registerAllResources(server, makeTM1Stub());

    const cb = readCallbacks.get("server-info");
    expect(cb).toBeDefined();
    const result = await cb!(new URL("tm1://server/info"));
    const text = result.contents[0]!.text;
    const payload = JSON.parse(text) as Record<string, unknown>;

    expect(text).not.toContain("ldap-secret");
    expect(payload.extra).toBeUndefined();
    expect(payload.serverName).toBe("testserver");
    expect(payload.productVersion).toBe("11.8.0");
  });
});
