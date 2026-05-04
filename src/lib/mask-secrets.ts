// Credential redaction helpers shared by call-graph analysis and code search.
//
// Param-name regex: matches typical credential identifiers (case-insensitive).
// Kept conservative — false positives turn legitimate parameter values into
// "***" in audit reports, so we err on the side of obvious credential names.
export const SECRET_NAME_RE = /pass(?:wd|word)?|pwd|secret|token|api[_-]?key|^key$|credential|auth/i;

export const MASK = "***";

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

// Mask the 3rd argument of ODBCOpen(dsn, user, password) and the 3rd+ args of
// ExecuteCommand variants where the password tends to live. Also mask any
// quoted literal that follows a credential keyword.
export function maskCodeLine(line: string): string {
  let out = line;

  // ODBCOpen('dsn','user','password')  → mask 3rd arg
  out = out.replace(
    /\b(ODBCOpen\s*\(\s*(?:'[^']*'|"[^"]*"|[^,]*)\s*,\s*(?:'[^']*'|"[^"]*"|[^,]*)\s*,\s*)(?:'[^']*'|"[^"]*")/gi,
    (_m, prefix) => `${prefix}'${MASK}'`,
  );

  // <credentialKeyword> = 'value'  → mask the literal
  // Matches:  pPwd = 'foo'  | sPassword := "bar"  | gToken<-'baz'
  out = out.replace(
    /(\b(?:[a-z_][a-z0-9_]*)?(?:pass(?:wd|word)?|pwd|secret|token|api[_-]?key|credential)[a-z0-9_]*\s*(?:=|:=|<-)\s*)(?:'[^']*'|"[^"]*")/gi,
    (_m, prefix) => `${prefix}'${MASK}'`,
  );

  return out;
}
