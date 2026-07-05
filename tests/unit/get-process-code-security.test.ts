import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerGetProcessCode } from "../../src/tools/ti-development/get-process-code.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

function captureHandler(processes: Partial<TM1Client["processes"]>): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerGetProcessCode(server, { processes } as unknown as TM1Client);
  if (!cb) throw new Error("handler not registered");
  return cb;
}

const code = { prolog: "p", metadata: "m", data: "d", epilog: "e" };

describe("tm1_get_process_code includeSecurityAccess", () => {
  it("omits the flag and skips getDeployMeta by default", async () => {
    let metaCalls = 0;
    const cb = captureHandler({
      getCode: async () => code,
      getDeployMeta: async () => {
        metaCalls += 1;
        return { hasSecurityAccess: true };
      },
    });
    const res = await cb({ processName: "p1" }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.hasSecurityAccess).toBeUndefined();
    expect(metaCalls).toBe(0);
  });

  it("includes the flag via getDeployMeta when opted in", async () => {
    const cb = captureHandler({
      getCode: async () => code,
      getDeployMeta: async () => ({ hasSecurityAccess: true }),
    });
    const res = await cb({ processName: "p1", includeSecurityAccess: true }, {});
    const payload = JSON.parse(res.content[0].text);
    expect(payload.hasSecurityAccess).toBe(true);
  });
});
