import { describe, it, expect } from "vitest";
import { isSecretName, maskCode, maskCodeLine, MASK } from "../../src/lib/mask-secrets.js";

describe("isSecretName", () => {
  it.each([
    ["pPwd", true],
    ["pPassword", true],
    ["sSecret", true],
    ["gApiKey", true],
    ["api_key", true],
    ["api-key", true],
    ["AuthToken", true],
    ["credential", true],
    ["pCubeName", false],
    ["dimensionName", false],
    ["sFile", false],
    ["userId", false],
  ])("isSecretName(%s) -> %s", (name, expected) => {
    expect(isSecretName(name)).toBe(expected);
  });
});

describe("maskCodeLine", () => {
  it("masks ODBCOpen 3rd argument", () => {
    const out = maskCodeLine("ODBCOpen('DSN', 'admin', 'Sup3rSecret!');");
    expect(out).toBe(`ODBCOpen('DSN', 'admin', '${MASK}');`);
  });

  it("masks quoted assignment after credential keyword", () => {
    const out = maskCodeLine("pPwd = 'plain-text';");
    expect(out).toContain(MASK);
    expect(out).not.toContain("plain-text");
  });

  it("masks double-quoted token assignment", () => {
    const out = maskCodeLine('sToken := "abc123";');
    expect(out).toContain(MASK);
    expect(out).not.toContain("abc123");
  });

  it("does not touch non-credential lines", () => {
    const line = "sCubeName = 'Sales';";
    expect(maskCodeLine(line)).toBe(line);
  });

  it("preserves first two ODBCOpen args", () => {
    const out = maskCodeLine("ODBCOpen('MyDSN', 'svc_user', 'topSecret');");
    expect(out).toContain("'MyDSN'");
    expect(out).toContain("'svc_user'");
    expect(out).not.toContain("topSecret");
  });

  it("masks conn-string creds in DSN-less ODBCOpen first arg (bypass #1)", () => {
    const out = maskCodeLine(
      "ODBCOpen('Driver={SQL Server};Server=srv;UID=admin;PWD=hunter2;', '', '');",
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("admin");
    expect(out).toContain("PWD=***");
    expect(out).toContain("UID=***");
  });

  it("masks conn-string creds assigned to non-credential var (bypass #2)", () => {
    const out = maskCodeLine(
      "sConn = 'Provider=SQLOLEDB;Server=srv;UID=admin;PWD=hunter2;';",
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("admin");
    expect(out).toContain("PWD=***");
    expect(out).toContain("UID=***");
  });
});

describe("maskCode", () => {
  it("masks credential literals across every line of a multi-line blob", () => {
    const code = [
      "sMsg = 'start';",
      "ODBCOpen('SalesDSN', 'svc_user', 'S3cr3t_Pw!');",
      "pPwd = 'anotherSecret';",
    ].join("\n");
    const out = maskCode(code);
    expect(out).not.toContain("S3cr3t_Pw!");
    expect(out).not.toContain("anotherSecret");
    expect(out).toContain(MASK);
    // Non-credential line untouched.
    expect(out).toContain("sMsg = 'start';");
  });

  it("preserves CRLF line endings byte-for-byte", () => {
    const code = "a = 1;\r\nODBCOpen('D', 'u', 'pw');\r\nb = 2;";
    const out = maskCode(code);
    expect(out).toContain("\r\n");
    expect(out).not.toContain("'pw'");
  });
});
