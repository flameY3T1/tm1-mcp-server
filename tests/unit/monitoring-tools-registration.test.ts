import { describe, it, expect } from "vitest";
import { registerGetJobs } from "../../src/tools/operations/get-jobs.js";
import { registerGetThreads } from "../../src/tools/operations/get-threads.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";

function mockServer() {
  const names: string[] = [];
  const server = { tool: (name: string) => void names.push(name) } as unknown as McpServer;
  return { server, names };
}
const clientWith = (version: 11 | 12) =>
  ({ version, monitoring: {} }) as unknown as TM1Client;

describe("version-gated monitoring tools", () => {
  it("v12 registers job tools and no thread tools", () => {
    const j = mockServer();
    registerGetJobs(j.server, clientWith(12));
    expect(j.names).toEqual(["tm1_list_jobs", "tm1_cancel_job"]);
    const t = mockServer();
    registerGetThreads(t.server, clientWith(12));
    expect(t.names).toEqual([]);
  });

  it("v11 registers thread tools and no job tools", () => {
    const t = mockServer();
    registerGetThreads(t.server, clientWith(11));
    expect(t.names).toEqual(["tm1_list_threads", "tm1_cancel_thread"]);
    const j = mockServer();
    registerGetJobs(j.server, clientWith(11));
    expect(j.names).toEqual([]);
  });
});
