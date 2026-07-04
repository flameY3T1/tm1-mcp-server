import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error } from "../../src/types.js";
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

describe("tm1_execute_process abort handling (M2)", () => {
  it("swaps in an abort hint when the client cancels mid-run", async () => {
    const controller = new AbortController();
    controller.abort();
    const cb = captureHandler(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    let caught: unknown;
    try {
      await cb({ processName: "Long.Process" }, { signal: controller.signal });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TM1Error);
    const err = caught as TM1Error;
    expect(err.message).toContain("cancelled client-side");
    expect(err.hint).toContain("tm1_list_threads");
    expect(err.hint).toContain("tm1_cancel_thread");
    // The misleading "re-run after diagnosing" guidance must be gone — the TI
    // may still be running, so re-running risks a duplicate execution.
    expect(err.hint).not.toContain("diagnose_process_error");
  });

  it("keeps the runtime hint when the failure is a genuine error, not a cancellation", async () => {
    const cb = captureHandler(async () => {
      throw new Error("boom");
    });

    let caught: unknown;
    try {
      await cb({ processName: "Broken.Process" }, {});
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TM1Error);
    expect((caught as TM1Error).hint).toContain("tm1_diagnose_process_error");
  });
});
