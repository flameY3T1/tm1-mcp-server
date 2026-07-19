import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerGetServerInfo } from "../../src/tools/operations/get-server-info.js";

// S1: tm1_get_server_info surfaces the full merged /Configuration under `_raw`.
// That dump must never leave the server with credential-named values in the
// clear — masking is unconditional (no opt-out flag on this tool).

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function capture(extra: Record<string, unknown>): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  const tm1 = {
    server: {
      getInfo: async () => ({
        serverName: "testserver",
        productVersion: "11.8.0",
        extra,
      }),
    },
  } as unknown as TM1Client;
  registerGetServerInfo(server, tm1);
  if (!cb) throw new Error("handler not registered");
  return cb;
}

describe("tm1_get_server_info – _raw credential masking", () => {
  it("masks credential-named values in the raw config dump", async () => {
    const cb = capture({
      Access: {
        // LDAP is not a credential key, but Password nested under it is → the
        // value is masked while sibling non-secret fields survive.
        LDAP: { Enable: true, Password: "ldap-secret" },
        // The whole Authentication node matches the credential regex ("auth"),
        // so it is masked wholesale — its secret child never serializes.
        Authentication: { SecurityPackageName: "kerberos", ServiceAuthPassword: "svc-secret" },
      },
      Performance: { MTQ: { UseAllThreads: true } },
    });

    const res = await cb({ format: "json" }, {});
    const text = res.content[0].text;

    // No credential literal survives anywhere in the serialized payload.
    expect(text).not.toContain("ldap-secret");
    expect(text).not.toContain("svc-secret");

    const payload = JSON.parse(text) as { _raw: Record<string, any> };
    expect(payload._raw.Access.LDAP.Password).toBe("***");
    expect(payload._raw.Access.Authentication).toBe("***");
    // Non-secret values are preserved intact.
    expect(payload._raw.Access.LDAP.Enable).toBe(true);
    expect(payload._raw.Performance.MTQ.UseAllThreads).toBe(true);
  });
});
