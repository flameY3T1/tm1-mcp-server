import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TM1Client } from "../../src/tm1-client.js";
import { registerExportProcessToPro } from "../../src/tools/ti-development/export-process-to-pro.js";
import { serializeProcessToGit } from "../../src/lib/git-process.js";
import { serializeToPro } from "../../src/lib/pro-serializer.js";
import { parseProFile } from "../../src/lib/pro-parser.js";

type ToolCb = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;

// The ODBC password is a server-bound ciphertext on v11 and plain text on v12,
// so it only leaves the server when the caller asks for it AND names a file.
function captureProExport(): { cb: ToolCb; secretsAsked: boolean[] } {
  const secretsAsked: boolean[] = [];
  const processes = {
    getCode: async () => ({
      prolog: "sVal = 'x';",
      metadata: "",
      data: "",
      epilog: "",
    }),
    getParameters: async () => [],
    getVariables: async () => [],
    getDataSource: async (_n: string, opts?: { includeSecrets?: boolean }) => {
      secretsAsked.push(opts?.includeSecrets === true);
      return {
        type: "ODBC" as const,
        dataSourceNameForServer: "SALES_DWH",
        userName: "etl_reader",
        query: "SELECT 1",
        // Mirrors the service: a marker stands in for the credential unless
        // secrets were asked for — and the marker must never reach the file.
        password: opts?.includeSecrets
          ? "W0br6scX06nUHxVZQrQC+g=="
          : "[redacted]",
      };
    },
  };
  let cb: ToolCb | undefined;
  const server = {
    tool: (_n: string, _d: string, _s: unknown, handler: ToolCb) => {
      cb = handler;
    },
  } as unknown as McpServer;
  registerExportProcessToPro(server, { processes } as unknown as TM1Client);
  if (!cb) throw new Error("handler not registered");
  return { cb, secretsAsked };
}

describe("credential export is opt-in", () => {
  it("does not ask the client for secrets by default", async () => {
    const { cb, secretsAsked } = captureProExport();
    const res = await cb({ processName: "P", maskSecrets: true }, {});
    const payload: Record<string, unknown> = JSON.parse(res.content[0].text);
    expect(secretsAsked).toEqual([false]);
    expect(payload.credentialsIncluded).toBe(false);
    expect(String(payload.content)).not.toContain("565,");
    expect(String(payload.content)).not.toContain("redacted");
  });

  it("refuses to include the password without a file target", async () => {
    const { cb } = captureProExport();
    await expect(
      cb({ processName: "P", includeDataSourcePassword: true }, {}),
    ).rejects.toThrow(/requires writeToFile/);
  });

  it("keeps the body out of the response when credentials are included", async () => {
    const { cb, secretsAsked } = captureProExport();
    // resolveLocalPath rejects unless TM1_LOCAL_FILE_ROOT is configured, so the
    // call fails at the write step — after the secret decision under test.
    await expect(
      cb(
        {
          processName: "P",
          includeDataSourcePassword: true,
          writeToFile: "/tmp/P.pro",
        },
        {},
      ),
    ).rejects.toThrow();
    expect(secretsAsked).toEqual([true]);
  });
});

describe("password slots in the two file formats", () => {
  const ds = {
    type: "ODBC" as const,
    dataSourceNameForServer: "SALES_DWH",
    userName: "etl_reader",
    password: "W0br6scX06nUHxVZQrQC+g==",
  };

  it(".pro writes 565 only when a password is present, and reads it back", () => {
    const withPwd = serializeToPro({ name: "P", prolog: "x", dataSource: ds });
    expect(withPwd).toContain(`565,"W0br6scX06nUHxVZQrQC+g=="`);
    expect(parseProFile(withPwd).dataSource.password).toBe(
      "W0br6scX06nUHxVZQrQC+g==",
    );

    const withoutPwd = serializeToPro({
      name: "P",
      prolog: "x",
      dataSource: { ...ds, password: "" },
    });
    expect(withoutPwd).not.toContain("565,");
  });

  it("ignores 565 in files TM1 wrote — that blob is TM1's own file encoding", () => {
    const tm1Written = [
      `601,100`,
      `602,"P"`,
      `562,"ODBC"`,
      `586,"SALES_DWH"`,
      `585,`,
      `564,"etl_reader"`,
      `565,"yyf]XR<50pIeOFYacGAR^37Hvi_LEDN2"`,
      `566,1`,
      `SELECT 1`,
      `572,0`,
    ].join("\n");
    expect(parseProFile(tm1Written).dataSource.password).toBeUndefined();
  });

  it("git json keeps the password only when asked", () => {
    const input = {
      name: "P",
      dataSource: ds,
      parameters: [],
      variables: [],
      hasSecurityAccess: false,
    };
    const stripped = serializeProcessToGit(input);
    expect(stripped.credentialsOmitted).toBe(true);
    expect(stripped.json).not.toContain("W0br");

    const kept = serializeProcessToGit(input, { includePassword: true });
    expect(kept.credentialsOmitted).toBe(false);
    expect(kept.json).toContain("W0br6scX06nUHxVZQrQC+g==");
  });
});
