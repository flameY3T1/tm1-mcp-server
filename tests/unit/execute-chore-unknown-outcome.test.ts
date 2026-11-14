import { describe, it, expect } from "vitest";
import { contractCheckedClient } from "../helpers/service-contract.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { TM1Error } from "../../src/types.js";
import { registerExecuteChore } from "../../src/tools/scheduling/execute-chore.js";

type ToolCb = (
  args: { choreName: string; confirm: string },
  extra: Record<string, unknown>,
) => Promise<unknown>;

function captureHandler(execute: TM1Client["chores"]["execute"]): ToolCb {
  let cb: ToolCb | undefined;
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerExecuteChore(
    server,
    contractCheckedClient({ chores: { execute } } as unknown as TM1Client),
  );
  if (!cb) throw new Error("handler was not registered");
  return cb;
}

describe("tm1_execute_chore unknown outcome (F7)", () => {
  it("says the chore may be running when TM1 did not answer", async () => {
    const cb = captureHandler(async () => {
      throw new TM1Error({ code: "LOCK_TIMEOUT", message: "timed out" });
    });
    await expect(
      cb({ choreName: "Nightly", confirm: "Nightly" }, {}),
    ).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
      hint: expect.stringContaining("may or may not have started"),
    });
  });

  it("leaves an error TM1 answered with untouched", async () => {
    const cb = captureHandler(async () => {
      throw new TM1Error({
        code: "NOT_FOUND",
        message: "no such chore",
        httpStatus: 404,
      });
    });
    let caught: unknown;
    try {
      await cb({ choreName: "Nope", confirm: "Nope" }, {});
    } catch (e) {
      caught = e;
    }
    expect((caught as TM1Error).hint).not.toContain("may or may not");
  });
});
