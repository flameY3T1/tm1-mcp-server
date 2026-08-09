import { describe, it, expect, afterEach } from "vitest";
import {
  isSecretName,
  maskCode,
  maskCodeLine,
  maskConnectionString,
  maskDataSourceSecrets,
  maskSecretValues,
  resolveMaskSecrets,
  MASK,
} from "../../src/lib/mask-secrets.js";

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

  it("does not swallow the trailing \\r when masking a bare conn-string credential pair on a CRLF line", () => {
    // Regression: the value capture in maskCodeLine's conn-string pass used to
    // be an unbounded [^;'"]+, which greedily consumed the trailing \r of a
    // CRLF-terminated line into the masked-away value, silently converting
    // that line's ending from CRLF to LF (byte-identity break on .ti export).
    const code = "sConn = PWD=hunter2\r\nb = 2;";
    const out = maskCode(code);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("\r\n");
    // The masked line itself must still end in \r right before the split \n.
    const maskedLine = out.split("\n")[0]!;
    expect(maskedLine.endsWith("\r")).toBe(true);
  });
});

describe("maskConnectionString", () => {
  it("masks PWD and UID values, keeps non-credential pairs", () => {
    const out = maskConnectionString(
      "Driver={SQL Server};Server=srv01;UID=admin;PWD=hunter2;Database=Sales",
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("admin");
    expect(out).toBe(
      `Driver={SQL Server};Server=srv01;UID=${MASK};PWD=${MASK};Database=Sales`,
    );
  });

  it("masks Password= and User Id= variants case-insensitively", () => {
    const out = maskConnectionString("server=s;user id=svc;password=S3cr3t!;");
    expect(out).not.toContain("svc");
    expect(out).not.toContain("S3cr3t!");
  });

  it("leaves credential-free connection strings unchanged", () => {
    const conn =
      "Driver={SQL Server};Server=srv01;Database=Sales;Trusted_Connection=yes";
    expect(maskConnectionString(conn)).toBe(conn);
  });
});

describe("maskDataSourceSecrets", () => {
  it("masks oDBCConnection and preserves the other fields", () => {
    const ds = {
      type: "ODBC",
      userName: "svc",
      oDBCConnection: "DSN=Sales;UID=admin;PWD=hunter2;",
    };
    const out = maskDataSourceSecrets(ds);
    expect(out.oDBCConnection).not.toContain("hunter2");
    expect(out.oDBCConnection).toContain(MASK);
    expect(out.type).toBe("ODBC");
    expect(out.userName).toBe("svc");
    // Input object untouched (copy, not mutation).
    expect(ds.oDBCConnection).toContain("hunter2");
  });

  it("is a no-op when oDBCConnection is absent", () => {
    const ds = { type: "TM1CubeView", view: "Default" };
    const out = maskDataSourceSecrets(ds);
    // Same reference back — no copy, no added key.
    expect(out).toBe(ds);
    expect(Object.keys(out)).toEqual(["type", "view"]);
    // Return type stays tied to the input type: these fields are typed, not
    // `unknown`, so a widened signature would fail the typecheck gate.
    expect(out.type).toBe("TM1CubeView");
    expect(out.view).toBe("Default");
  });

  it("is a no-op when oDBCConnection is present but undefined", () => {
    const ds: { type: string; oDBCConnection?: string | undefined } = {
      type: "ODBC",
      oDBCConnection: undefined,
    };
    expect(maskDataSourceSecrets(ds)).toBe(ds);
  });
});

describe("v12 credential names", () => {
  it("treats v12 secret fields as secrets", () => {
    expect(isSecretName("clientSecret")).toBe(true);
    expect(isSecretName("accessToken")).toBe(true);
    expect(isSecretName("apiKey")).toBe(true);
    expect(isSecretName("TM1_CLIENT_SECRET")).toBe(true);
  });

  it("does not mask the non-secret client id", () => {
    expect(isSecretName("clientId")).toBe(false);
  });
});

// S6: ODBC brace-quotes a value precisely so it MAY contain the delimiter.
// A value regex that stops at the first ';' masked "{abc" and left "def};"
// in the output — a partial leak that looks masked.
describe("maskConnectionString — brace-quoted values", () => {
  it("masks a braced value containing the delimiter whole", () => {
    const out = maskConnectionString("Driver={SQL};UID=admin;PWD={abc;def};");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("def");
    expect(out).toContain(`PWD=${MASK}`);
  });

  it("still masks the plain form", () => {
    expect(maskConnectionString("PWD=hunter2;")).toBe(`PWD=${MASK};`);
  });

  it("leaves a non-credential braced value alone", () => {
    expect(maskConnectionString("Driver={SQL Server};")).toContain(
      "{SQL Server}",
    );
  });
});

// S4/S5: pino's redact is KEY-based, so it masks {password: "x"} but never a
// credential embedded in a message string. Those strings are exactly what TM1
// returns on an ODBC failure, and they went to the log and back to the client.
describe("maskSecretValues — value-oriented masking of free text", () => {
  it.each([
    ["ODBC connect failed: PWD=hunter2", "hunter2"],
    ["login rejected (UID=admin;PWD={a;b})", "a;b"],
    ["auth error: token=abc123 rejected", "abc123"],
    ["Password: 'geheim' was refused", "geheim"],
  ])("removes the credential from %o", (input, secret) => {
    const out = maskSecretValues(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(MASK);
  });

  it("leaves ordinary error text untouched", () => {
    const msg = "'CUBE_X' can not be found in collection of type 'Cube'.";
    expect(maskSecretValues(msg)).toBe(msg);
  });

  it("is idempotent — masking twice changes nothing", () => {
    const once = maskSecretValues("PWD=hunter2");
    expect(maskSecretValues(once)).toBe(once);
  });

  it("handles empty input", () => {
    expect(maskSecretValues("")).toBe("");
  });
});

// S8: `maskSecrets:false` is a MODEL-controlled opt-out of a security control.
// The operator has to allow it out-of-band; default is deny.
describe("resolveMaskSecrets — the opt-out needs operator consent", () => {
  const original = process.env.TM1_ALLOW_UNMASKED_SECRETS;
  afterEach(() => {
    if (original === undefined) delete process.env.TM1_ALLOW_UNMASKED_SECRETS;
    else process.env.TM1_ALLOW_UNMASKED_SECRETS = original;
  });

  it("masks when asked to mask", () => {
    expect(resolveMaskSecrets(true)).toBe(true);
    expect(resolveMaskSecrets(undefined)).toBe(true);
  });

  it("masks ANYWAY when the model asks not to and the operator did not allow it", () => {
    delete process.env.TM1_ALLOW_UNMASKED_SECRETS;
    expect(resolveMaskSecrets(false)).toBe(true);
  });

  it("honours the opt-out only with explicit operator consent", () => {
    process.env.TM1_ALLOW_UNMASKED_SECRETS = "true";
    expect(resolveMaskSecrets(false)).toBe(false);
    // …and still masks when nobody asked for raw output.
    expect(resolveMaskSecrets(true)).toBe(true);
  });

  it("treats any value other than the exact string 'true' as deny", () => {
    process.env.TM1_ALLOW_UNMASKED_SECRETS = "1";
    expect(resolveMaskSecrets(false)).toBe(true);
  });
});
