import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerCheckProcessCode } from "../../src/tools/ti-development/check-process-code.js";

// Syntax errors are the expected output of this validator. The failure payload
// must carry its own code/message/hint so the isError normalizer does not
// stamp a generic TM1_ERROR envelope (with the whole payload duplicated into
// `message`) over it — observed in the 2026-07-04 prod live sweep.
type ToolCb = (
  args: { name?: string; prolog?: string },
  extra: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

function captureHandler(check: TM1Client["processes"]["check"]): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  const client = { processes: { check } } as unknown as TM1Client;
  registerCheckProcessCode(server, client);
  if (!cb) throw new Error("handler was not registered");
  return cb;
}

describe("tm1_check_process_code failure payload", () => {
  it("carries code/message/hint alongside the compile errors", async () => {
    const cb = captureHandler(async () => ({
      success: false,
      errors: [{ lineNumber: 2, procedure: "Prolog", message: "missing bracket" }],
    }));
    const result = await cb({ name: "_probe", prolog: "nX = (" }, {});
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.errorCount).toBe(1);
    expect(payload.errors[0].message).toBe("missing bracket");
    expect(payload.code).toBe("VALIDATION_ERROR");
    expect(payload.message).toBe("TI syntax check failed: 1 error(s)");
    expect(payload.hint).toContain("errors[]");
  });

  it("keeps the success payload free of error envelope fields", async () => {
    const cb = captureHandler(async () => ({ success: true, errors: [] }));
    const result = await cb({ name: "_probe", prolog: "nX = 1;" }, {});
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(payload.ok).toBe(true);
    expect(payload.code).toBeUndefined();
    expect(payload.message).toBeUndefined();
    expect(payload.hint).toBeUndefined();
  });
});
