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

  // Connection-string credential pairs embedded INSIDE a string literal, e.g.
  //   'Driver={SQL Server};Server=srv;UID=admin;PWD=hunter2;'
  // These slip past the arg-position and keyword-before-'=' passes because the
  // credential lives inside another literal (ODBCOpen 1st arg, or a conn string
  // assigned to a non-credential-named var). Mask just the VALUE, keep the key.
  // Value = bare token up to the next ';' or quote (unquoted conn-string syntax);
  // the [^;'"]+ capture is a single linear quantifier — no nested backtracking.
  out = out.replace(
    /\b(pwd|password|uid|user\s*id)(\s*=\s*)([^;'"]+)/gi,
    (_m, key, eq) => `${key}${eq}${MASK}`,
  );

  return out;
}

// Mask credential literals across a whole (possibly multi-line) code blob by
// applying maskCodeLine to each line. Splits on "\n" only so CRLF/CR endings
// are preserved byte-for-byte (the trailing "\r" rides along on each line and
// is untouched by maskCodeLine).
export function maskCode(code: string): string {
  return code.split("\n").map(maskCodeLine).join("\n");
}
