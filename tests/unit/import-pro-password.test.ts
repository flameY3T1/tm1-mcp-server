import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import type { DataSource } from "../../src/types.js";
import { registerImportProFile } from "../../src/tools/ti-development/import-pro-file.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// A .pro never carries a usable ODBC password — TM1 stores it as a
// server-encrypted blob — so the caller re-supplies it on import.
const ODBC_PRO = [
  `602,"Import_Sales"`,
  `562,"ODBC"`,
  `586,"SALES_DWH"`,
  `585,`,
  `564,"etl_reader"`,
  `566,1`,
  `SELECT 1`,
  `572,1`,
  `sVal = 'x';`,
  `573,0`,
  `574,0`,
  `575,0`,
].join("\n");

function capture(): { cb: ToolCb; applied: DataSource[] } {
  const applied: DataSource[] = [];
  const processes = {
    list: async () => [],
    create: async () => undefined,
    updateCode: async () => undefined,
    updateParameters: async () => undefined,
    updateVariables: async () => undefined,
    updateDataSource: async (_name: string, ds: DataSource) => {
      applied.push(ds);
    },
  };
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerImportProFile(server, {
    processes,
  } as unknown as TM1Client);
  if (!cb) throw new Error("handler not registered");
  return { cb, applied };
}

describe("tm1_import_pro_file: ODBC password", () => {
  it("injects dataSourcePassword into the parsed datasource", async () => {
    const { cb, applied } = capture();
    await cb(
      {
        content: ODBC_PRO,
        mode: "create",
        preflight: false,
        dataSourcePassword: "s3cret",
      },
      {},
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      type: "ODBC",
      dataSourceNameForServer: "SALES_DWH",
      userName: "etl_reader",
      query: "SELECT 1",
      password: "s3cret",
    });
  });

  it("leaves the password unset when none is supplied", async () => {
    const { cb, applied } = capture();
    await cb({ content: ODBC_PRO, mode: "create", preflight: false }, {});
    expect(applied[0]?.password).toBeUndefined();
  });

  it("ignores the password for a non-ODBC datasource", async () => {
    const { cb, applied } = capture();
    const viewPro = [
      `602,"Load_View"`,
      `562,"VIEW"`,
      `586,"Sales"`,
      `585,`,
      `570,MyView`,
      `572,1`,
      `sVal = 'x';`,
      `573,0`,
      `574,0`,
      `575,0`,
    ].join("\n");
    await cb(
      {
        content: viewPro,
        mode: "create",
        preflight: false,
        dataSourcePassword: "s3cret",
      },
      {},
    );
    expect(applied[0]).not.toHaveProperty("password");
  });
});
