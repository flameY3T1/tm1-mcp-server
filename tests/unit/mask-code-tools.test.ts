import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { DataSource } from "../../src/types.js";
import { registerGetProcessCode } from "../../src/tools/ti-development/get-process-code.js";
import { registerExportProcessToPro } from "../../src/tools/ti-development/export-process-to-pro.js";
import { registerExportProcessToGit } from "../../src/tools/ti-development/export-process-to-git.js";
import { registerDiffProcesses } from "../../src/tools/ti-development/diff-processes.js";
import { registerDiffProcessWithFile } from "../../src/tools/ti-development/diff-process-with-file.js";
import { serializeToPro } from "../../src/lib/pro-serializer.js";

// Finding #1: five code-reading tools returned/wrote TI code verbatim, leaking
// inline ODBC credentials. Each now masks the code payload by default.

type Handler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// Capture the raw zod shape + handler a register* fn passes to server.tool, then
// run inputs through z.object(shape).parse to apply schema defaults (maskSecrets
// defaults to true) exactly as the live SDK would before the handler runs.
function capture(
  register: (server: McpServer, client: TM1Client) => void,
  client: TM1Client,
): { schema: ZodRawShape; handler: Handler } {
  let schema: ZodRawShape | undefined;
  let handler: Handler | undefined;
  const server = {
    tool: (_name: string, _desc: string, s: ZodRawShape, h: Handler) => {
      schema = s;
      handler = h;
    },
  } as unknown as McpServer;
  register(server, client);
  if (!schema || !handler) throw new Error("tool was not registered");
  return { schema, handler };
}

async function run(
  register: (server: McpServer, client: TM1Client) => void,
  client: TM1Client,
  input: Record<string, unknown>,
): Promise<string> {
  const { schema, handler } = capture(register, client);
  const args = z.object(schema).parse(input);
  const res = await handler(args as Record<string, unknown>, {});
  return res.content[0]!.text;
}

const NONE_DS: DataSource = { type: "None" };
const ODBC = (pw: string) => `ODBCOpen('SalesDSN', 'svc_user', '${pw}');`;

// A processes stub whose getCode returns per-process code maps.
function clientWith(codeByProcess: Record<string, Record<string, string>>): TM1Client {
  return {
    processes: {
      getCode: async (name: string) => {
        const c = codeByProcess[name] ?? {};
        return { prolog: c.prolog ?? "", metadata: c.metadata ?? "", data: c.data ?? "", epilog: c.epilog ?? "" };
      },
      getParameters: async () => [],
      getVariables: async () => [],
      getDataSource: async () => NONE_DS,
      getDeployMeta: async () => ({ hasSecurityAccess: false }),
    },
  } as unknown as TM1Client;
}

describe("tm1_get_process_code masks inline ODBC credentials", () => {
  const client = clientWith({ "Load.Sales": { prolog: ODBC("S3cr3t_Pw!") } });

  it("masks the password by default", async () => {
    const text = await run(registerGetProcessCode, client, { processName: "Load.Sales" });
    expect(text).not.toContain("S3cr3t_Pw!");
    expect(text).toContain("***");
  });

  it("returns raw code when maskSecrets=false", async () => {
    const text = await run(registerGetProcessCode, client, { processName: "Load.Sales", maskSecrets: false });
    expect(text).toContain("S3cr3t_Pw!");
  });
});

describe("tm1_export_process_to_pro masks inline ODBC credentials", () => {
  const client = clientWith({ "Load.Sales": { prolog: ODBC("S3cr3t_Pw!") } });

  it("masks the password in the returned .pro content by default", async () => {
    const text = await run(registerExportProcessToPro, client, { processName: "Load.Sales" });
    expect(text).not.toContain("S3cr3t_Pw!");
    expect(text).toContain("***");
  });

  it("returns raw content when maskSecrets=false", async () => {
    const text = await run(registerExportProcessToPro, client, { processName: "Load.Sales", maskSecrets: false });
    expect(text).toContain("S3cr3t_Pw!");
  });
});

describe("tm1_export_process_to_git masks inline ODBC credentials", () => {
  const client = clientWith({ "Load.Sales": { prolog: ODBC("S3cr3t_Pw!") } });

  it("masks the password in the returned .ti by default", async () => {
    const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales" });
    expect(text).not.toContain("S3cr3t_Pw!");
    expect(text).toContain("***");
  });

  it("returns raw .ti when maskSecrets=false", async () => {
    const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales", maskSecrets: false });
    expect(text).toContain("S3cr3t_Pw!");
  });

  describe("writeToDir persistence", () => {
    let root: string;
    let prevRoot: string | undefined;

    beforeEach(async () => {
      prevRoot = process.env.TM1_LOCAL_FILE_ROOT;
      root = await fs.mkdtemp(path.join(os.tmpdir(), "tm1-git-mask-"));
      process.env.TM1_LOCAL_FILE_ROOT = root;
    });
    afterEach(async () => {
      if (prevRoot === undefined) delete process.env.TM1_LOCAL_FILE_ROOT;
      else process.env.TM1_LOCAL_FILE_ROOT = prevRoot;
      await fs.rm(root, { recursive: true, force: true });
    });

    it("writes masked .ti content to disk by default", async () => {
      await run(registerExportProcessToGit, client, { processName: "Load.Sales", writeToDir: root });
      const onDisk = await fs.readFile(path.join(root, "Load.Sales.ti"), "utf8");
      expect(onDisk).not.toContain("S3cr3t_Pw!");
      expect(onDisk).toContain("***");
    });
  });
});

describe("tm1_diff_processes masks credentials in diff hunks", () => {
  // Same ODBC password on both sides; a nearby non-secret change forces the
  // ODBCOpen line into the diff as a context line.
  const client = clientWith({
    A: { prolog: `${ODBC("S3cr3t_Pw!")}\nsX = 1;` },
    B: { prolog: `${ODBC("S3cr3t_Pw!")}\nsX = 2;` },
  });

  it("masks the password in emitted hunk lines by default", async () => {
    const text = await run(registerDiffProcesses, client, { processA: "A", processB: "B" });
    expect(text).not.toContain("S3cr3t_Pw!");
    expect(text).toContain("***");
  });

  it("emits the raw password when maskSecrets=false", async () => {
    const text = await run(registerDiffProcesses, client, { processA: "A", processB: "B", maskSecrets: false });
    expect(text).toContain("S3cr3t_Pw!");
  });
});

describe("tm1_diff_process_with_file masks both sides before diffing", () => {
  // Installed and file differ ONLY in the ODBC password. Masking both sides
  // collapses them to the same literal, so the tab reports identical.
  const client = clientWith({ "Load.Sales": { prolog: ODBC("INSTALLED_Pw") } });
  const fileContent = serializeToPro({
    name: "Load.Sales",
    prolog: ODBC("FILE_Pw"),
    metadata: "",
    data: "",
    epilog: "",
    parameters: [],
    variables: [],
    dataSource: NONE_DS,
  });

  it("reports the prolog tab identical when only the password differs (default mask)", async () => {
    const text = await run(registerDiffProcessWithFile, client, { content: fileContent });
    const parsed = JSON.parse(text) as { tabs: Array<{ tab: string; identical: boolean }> };
    const prolog = parsed.tabs.find((t) => t.tab === "prolog")!;
    expect(prolog.identical).toBe(true);
    expect(text).not.toContain("INSTALLED_Pw");
    expect(text).not.toContain("FILE_Pw");
  });

  it("reports the prolog tab differing when maskSecrets=false", async () => {
    const text = await run(registerDiffProcessWithFile, client, { content: fileContent, maskSecrets: false });
    const parsed = JSON.parse(text) as { tabs: Array<{ tab: string; identical: boolean }> };
    const prolog = parsed.tabs.find((t) => t.tab === "prolog")!;
    expect(prolog.identical).toBe(false);
  });
});
