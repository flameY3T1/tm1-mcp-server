import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { TM1HttpClient } from "../../src/tm1-client/http.js";
import { ServerService } from "../../src/tm1-client/services/server-service.js";
import { registerDiagnoseProcessError } from "../../src/tools/operations/diagnose-process-error.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// The real ServerService over a canned ErrorLogFiles listing, so the filename
// filter that `since` relies on actually runs.
function captureHandler(filenames: string[]): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  const http = {
    request: async (_method: string, path: string) =>
      path.includes("/Content")
        ? "Error: something failed"
        : { value: filenames.map((Filename) => ({ Filename })) },
  } as unknown as TM1HttpClient;
  registerDiagnoseProcessError(server, {
    server: new ServerService(http),
  } as unknown as TM1Client);
  if (!cb) throw new Error("handler was not registered");
  return cb;
}

describe("tm1_diagnose_process_error since", () => {
  const OLD = "TM1ProcessError_20260101090000_1234_load_plan.log";
  const NEW = "TM1ProcessError_20260301090000_5678_load_plan.log";
  const args = {
    processName: "load_plan",
    maxLogs: 5,
    tail: 50,
    includeRelated: false,
    relatedWindowSec: 5,
    relatedMaxFiles: 5,
  };

  it("leaves out logs written before `since`", async () => {
    const cb = captureHandler([OLD, NEW]);
    const all = JSON.parse((await cb(args, {})).content[0]?.text ?? "");
    expect(JSON.stringify(all)).toContain(OLD);

    const result = await cb({ ...args, since: "2026-02-01T00:00:00" }, {});
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(NEW);
    expect(text).not.toContain(OLD);
  });
});
