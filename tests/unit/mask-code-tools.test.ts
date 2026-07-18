import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { DataSource } from "../../src/types.js";
import { registerGetProcessCode } from "../../src/tools/ti-development/get-process-code.js";
import { registerGetAllProcessesCode } from "../../src/tools/ti-development/get-all-processes-code.js";
import { registerGetProcessDatasource } from "../../src/tools/ti-development/get-process-datasource.js";
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

// Bulk-code stub mirroring the ProcessService.getAllCode overload: plain array
// without a cap, { items, total } when the tool pushes $top server-side.
function bulkCodeClient(
  rows: Array<{ name: string; prolog: string; metadata: string; data: string; epilog: string; hasSecurityAccess: boolean }>,
  opts?: { omitCount?: boolean },
): TM1Client {
  return {
    processes: {
      getAllCode: async (_includeControl?: boolean, top?: number) =>
        top === undefined
          ? rows
          : { items: rows.slice(0, top), total: opts?.omitCount ? undefined : rows.length },
    },
  } as unknown as TM1Client;
}

// A processes stub whose getCode returns per-process code maps.
function clientWith(codeByProcess: Record<string, Record<string, string>>): TM1Client {
  return {
    processes: {
      getCode: async (name: string) => {
        const c = codeByProcess[name] ?? {};
        return { prolog: c.prolog ?? "", metadata: c.metadata ?? "", data: c.data ?? "", epilog: c.epilog ?? "" };
      },
      getCodeBlob: async (name: string) => {
        const c = codeByProcess[name] ?? {};
        // Reconstruct the blob from structured code: prolog + metadata + data + epilog
        return (c.prolog ?? "") + (c.metadata ?? "") + (c.data ?? "") + (c.epilog ?? "");
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

    // When persisting to disk the caller has the files, so the full code bodies
    // must NOT be echoed back — otherwise every export doubles into the context
    // window. Metadata (filenames, counts, writtenTo paths) still comes back.
    it("omits json/ti from the response when writeToDir is set", async () => {
      const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales", writeToDir: root });
      const res = JSON.parse(text) as Record<string, unknown>;
      expect(res.json).toBeUndefined();
      expect(res.ti).toBeUndefined();
      expect(res.jsonFileName).toBe("Load.Sales.json");
      expect(res.tiFileName).toBe("Load.Sales.ti");
      expect(res.writtenTo).toMatchObject({
        json: path.join(root, "Load.Sales.json"),
        ti: path.join(root, "Load.Sales.ti"),
      });
    });

    // A not-yet-existing subdir below the root must be created (mkdir -p) after
    // confinement instead of surfacing a raw ENOENT.
    it("creates a missing subdirectory below the root before writing", async () => {
      const nested = path.join(root, "exports", "sales");
      const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales", writeToDir: nested });
      const res = JSON.parse(text) as Record<string, unknown>;
      expect(res.writtenTo).toMatchObject({
        json: path.join(nested, "Load.Sales.json"),
        ti: path.join(nested, "Load.Sales.ti"),
      });
      const onDisk = await fs.readFile(path.join(nested, "Load.Sales.ti"), "utf8");
      expect(onDisk).toContain("***");
    });

    // Same ENOENT gap existed on tm1_export_process_to_pro's writeToFile.
    it("tm1_export_process_to_pro creates missing parent dirs for writeToFile", async () => {
      const target = path.join(root, "pro", "deep", "Load.Sales.pro");
      const text = await run(registerExportProcessToPro, client, { processName: "Load.Sales", writeToFile: target });
      const res = JSON.parse(text) as Record<string, unknown>;
      expect(res.writtenTo).toBe(target);
      const onDisk = await fs.readFile(target, "utf8");
      expect(onDisk).toContain("***");
    });

    it("echoes json/ti inline when writeToDir is omitted", async () => {
      const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales" });
      const res = JSON.parse(text) as Record<string, unknown>;
      expect(typeof res.json).toBe("string");
      expect(typeof res.ti).toBe("string");
      expect(res.writtenTo).toMatchObject({ json: null, ti: null });
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

// Audit 2026-07-12 H1: the bulk code tool was the sole code-returning tool
// that skipped masking.
describe("tm1_get_all_processes_code masks inline ODBC credentials", () => {
  const client = bulkCodeClient([
    { name: "Load.Sales", prolog: ODBC("Bulk_Pw!"), metadata: "", data: "", epilog: "", hasSecurityAccess: false },
  ]);

  it("masks passwords in every returned tab by default", async () => {
    const text = await run(registerGetAllProcessesCode, client, {});
    expect(text).not.toContain("Bulk_Pw!");
    expect(text).toContain("***");
  });

  it("returns raw code when maskSecrets=false", async () => {
    const text = await run(registerGetAllProcessesCode, client, { maskSecrets: false });
    expect(text).toContain("Bulk_Pw!");
  });
});

// L5: summary mode drops the tab bodies and reports line metrics instead
// (mirrors tm1_get_all_cube_rules summary mode).
describe("tm1_get_all_processes_code summary mode", () => {
  const prolog = ["# header", "# more header", ODBC("Sum_Pw!"), "x = 1;"].join("\n");
  const client = bulkCodeClient([
    { name: "Load.Sales", prolog, metadata: "# meta only", data: "", epilog: "y = 2;", hasSecurityAccess: true },
  ]);

  it("returns per-process line metrics and no code bodies", async () => {
    const text = await run(registerGetAllProcessesCode, client, { summary: true });
    const parsed = JSON.parse(text) as {
      count: number;
      returned: number;
      truncated: boolean;
      processes: Array<Record<string, unknown>>;
    };
    expect(parsed.count).toBe(1);
    expect(parsed.returned).toBe(1);
    expect(parsed.truncated).toBe(false);
    // Exact-shape assert: metrics present, none of the four tab bodies.
    expect(parsed.processes[0]).toEqual({
      name: "Load.Sales",
      hasSecurityAccess: true,
      totalLines: 6,
      prologLines: 4,
      metadataLines: 1,
      dataLines: 0,
      epilogLines: 1,
      commentLines: 3,
    });
  });

  it("leaks no credentials even with maskSecrets=false (no code returned)", async () => {
    const text = await run(registerGetAllProcessesCode, client, { summary: true, maskSecrets: false });
    expect(text).not.toContain("Sum_Pw!");
    expect(text).not.toContain("ODBCOpen");
  });

  it("default mode is unchanged: tab bodies present, no metric fields", async () => {
    const text = await run(registerGetAllProcessesCode, client, {});
    const parsed = JSON.parse(text) as { processes: Array<Record<string, unknown>> };
    expect(parsed.processes[0]!.prolog).toContain("ODBCOpen");
    expect(parsed.processes[0]!.totalLines).toBeUndefined();
  });
});

// Token-opt 2026-07-18: full-code responses default-cap at 50 processes
// (server-side $top); summary mode still surveys the whole model by default.
describe("tm1_get_all_processes_code default cap", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    name: `Proc.${String(i).padStart(2, "0")}`,
    prolog: "x = 1;",
    metadata: "",
    data: "",
    epilog: "",
    hasSecurityAccess: false,
  }));
  const client = bulkCodeClient(rows);

  it("caps full-code responses at 50 by default and flags truncation", async () => {
    const text = await run(registerGetAllProcessesCode, client, {});
    const parsed = JSON.parse(text) as {
      count: number;
      countIsExact: boolean;
      returned: number;
      truncated: boolean;
      processes: unknown[];
    };
    expect(parsed.returned).toBe(50);
    expect(parsed.processes).toHaveLength(50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
    expect(parsed.countIsExact).toBe(true);
  });

  it("flags count as inexact lower bound when truncated and @odata.count is absent", async () => {
    const noCountClient = bulkCodeClient(rows, { omitCount: true });
    const parsed = JSON.parse(await run(registerGetAllProcessesCode, noCountClient, {})) as {
      count: number;
      countIsExact: boolean;
      truncated: boolean;
    };
    expect(parsed.truncated).toBe(true);
    // Sentinel fetch saw cap+1 rows — count is a lower bound, not the model total.
    expect(parsed.count).toBe(51);
    expect(parsed.countIsExact).toBe(false);
  });

  it("explicit limit overrides the default cap", async () => {
    const parsed = JSON.parse(await run(registerGetAllProcessesCode, client, { limit: 10 })) as {
      count: number;
      returned: number;
      truncated: boolean;
    };
    expect(parsed.returned).toBe(10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
  });

  it("limit=0 returns everything uncapped", async () => {
    const parsed = JSON.parse(await run(registerGetAllProcessesCode, client, { limit: 0 })) as {
      returned: number;
      truncated: boolean;
    };
    expect(parsed.returned).toBe(60);
    expect(parsed.truncated).toBe(false);
  });

  it("summary mode surveys all processes by default (no cap)", async () => {
    const parsed = JSON.parse(await run(registerGetAllProcessesCode, client, { summary: true })) as {
      returned: number;
      truncated: boolean;
    };
    expect(parsed.returned).toBe(60);
    expect(parsed.truncated).toBe(false);
  });

  it("explicit limit also caps summary mode", async () => {
    const parsed = JSON.parse(
      await run(registerGetAllProcessesCode, client, { summary: true, limit: 5 }),
    ) as { returned: number; truncated: boolean; count: number };
    expect(parsed.returned).toBe(5);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(60);
  });
});

// Audit 2026-07-12 M1: oDBCConnection strings carry PWD=/UID= pairs and passed
// through unmasked (tool output and git .json on disk).
const ODBC_DS: DataSource = {
  type: "ODBC",
  dataSourceNameForServer: "SalesDSN",
  userName: "svc_user",
  oDBCConnection: "Driver={SQL Server};Server=srv01;UID=conn_admin;PWD=Conn_Pw!;",
};

function clientWithDs(ds: DataSource): TM1Client {
  return {
    processes: {
      getCode: async () => ({ prolog: "", metadata: "", data: "", epilog: "" }),
      getCodeBlob: async () => "",
      getParameters: async () => [],
      getVariables: async () => [],
      getDataSource: async () => ds,
      getDeployMeta: async () => ({ hasSecurityAccess: false }),
    },
  } as unknown as TM1Client;
}

describe("tm1_get_process_datasource masks conn-string credentials", () => {
  const client = clientWithDs(ODBC_DS);

  it("masks PWD/UID pairs by default", async () => {
    const text = await run(registerGetProcessDatasource, client, { processName: "Load.Sales" });
    expect(text).not.toContain("Conn_Pw!");
    expect(text).not.toContain("conn_admin");
    expect(text).toContain("Driver={SQL Server}");
  });

  it("returns the raw connection string when maskSecrets=false", async () => {
    const text = await run(registerGetProcessDatasource, client, { processName: "Load.Sales", maskSecrets: false });
    expect(text).toContain("Conn_Pw!");
  });
});

describe("tm1_export_process_to_git masks the datasource conn-string in .json", () => {
  const client = clientWithDs(ODBC_DS);

  it("masks PWD/UID pairs in the emitted json by default", async () => {
    const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales" });
    expect(text).not.toContain("Conn_Pw!");
    expect(text).not.toContain("conn_admin");
  });

  it("emits the raw connection string when maskSecrets=false", async () => {
    const text = await run(registerExportProcessToGit, client, { processName: "Load.Sales", maskSecrets: false });
    expect(text).toContain("Conn_Pw!");
  });
});
