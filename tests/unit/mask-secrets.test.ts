import { describe, it, expect } from "vitest";
import { isSecretName, maskCodeLine, MASK } from "../../src/lib/mask-secrets.js";

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
});
