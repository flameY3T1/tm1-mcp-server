import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerExecuteProcess } from "../../src/tools/ti-development/execute-process.js";

// Capture the handler the tool registers, then invoke it directly with a
// stubbed TM1Client to assert the isError contract (T2.1): a TI process that
// runs but reports success:false must be surfaced as an MCP error, not a
// successful call carrying success:false.
type ToolCb = (
  args: { processName: string; parameters?: Record<string, string | number> },
  extra: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

function captureHandler(execute: TM1Client["processes"]["execute"]): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  const client = { processes: { execute } } as unknown as TM1Client;
  registerExecuteProcess(server, client);
  if (!cb) throw new Error("handler was not registered");
  return cb;
}

describe("tm1_execute_process isError contract (T2.1)", () => {
  it("flags isError when the TI run reports success:false", async () => {
    const cb = captureHandler(
      async () => ({ success: false, processErrorStatus: "DataSource error" })
    );
    const result = await cb({ processName: "Failing.Process" }, {});
    expect(result.isError).toBe(true);
    // Payload is preserved for diagnosis.
    expect(result.content[0]?.text).toContain("DataSource error");
  });

  it("does not flag isError on a successful run", async () => {
    const cb = captureHandler(
      async () => ({ success: true, processErrorStatus: "CompletedSuccessfully" })
    );
    const result = await cb({ processName: "Ok.Process" }, {});
    expect(result.isError).toBeUndefined();
  });
});
