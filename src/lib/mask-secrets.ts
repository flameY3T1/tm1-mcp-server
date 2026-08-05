// Credential redaction helpers shared by call-graph analysis and code search.
//
// Param-name regex: matches typical credential identifiers (case-insensitive).
// Kept conservative — false positives turn legitimate parameter values into
// "***" in audit reports, so we err on the side of obvious credential names.
export const SECRET_NAME_RE =
  /pass(?:wd|word)?|pwd|secret|token|api[_-]?key|^key$|credential|auth/i;

export const MASK = "***";

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

// Credential pair inside a connection string: `PWD=secret;`, `UID=admin;`.
//
// The value alternation is grammar-aware, and that is the whole point. ODBC
// lets a value be brace-quoted precisely so it may contain the delimiter:
// `PWD={abc;def};`. A plain `[^;]+` stops at the first inner `;`, masks `{abc`
// and leaves `def};` sitting in the output as cleartext — a partial leak that
// looks masked. Brace form is therefore matched FIRST and consumed whole.
//
// Both branches are single linear quantifiers over a negated class, so there is
// no nested backtracking to exploit.
export const CONN_CREDENTIAL_RE =
  /\b(pwd|password|uid|user\s*id)(\s*=\s*)(\{[^}]*\}|[^;'"\r\n]*)/gi;

// Value-oriented sanitizer for arbitrary free text — error messages, server
// responses, log lines. Distinct from maskSecretsDeep, which is KEY-oriented
// and therefore blind to a credential embedded in a string: pino's redact
// config masks `{password: "x"}` but never
// `err.message = "ODBC failed: PWD=hunter2"`.
//
// Deliberately narrow: only credential pairs with an explicit key. Guessing at
// bare tokens would mangle legitimate error text and train readers to ignore
// the mask.
export function maskSecretValues(text: string): string {
  if (!text) return text;
  return text
    .replace(CONN_CREDENTIAL_RE, (_m, key, eq) => `${key}${eq}${MASK}`)
    .replace(
      /\b(pass(?:wd|word)?|secret|token|api[_-]?key|credential)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
      (_m, key, sep) => `${key}${sep}${MASK}`,
    );
}

// Whether a caller may switch credential masking OFF.
//
// `maskSecrets: false` is a MODEL-controlled opt-out of a security control —
// the LLM can ask for raw credentials and, before this gate, got them. Now the
// operator has to allow it out-of-band. Default is deny, so the tool parameter
// degrades to "mask anyway" rather than failing the call: an audit that asked
// for unmasked output still gets its report, just redacted.
export function resolveMaskSecrets(requested: boolean | undefined): boolean {
  if (requested !== false) return true;
  return process.env.TM1_ALLOW_UNMASKED_SECRETS !== "true";
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
  // Value = bare token up to the next ';', quote, or line terminator (unquoted
  // conn-string syntax); the [^;'"\r\n]+ capture is a single linear quantifier
  // — no nested backtracking. Excluding \r\n keeps a trailing CR (CRLF line
  // ending) out of the match so masking a conn-string line never converts
  // CRLF→LF on the CRLF-sensitive .ti export.
  out = out.replace(CONN_CREDENTIAL_RE, (_m, key, eq) => `${key}${eq}${MASK}`);

  return out;
}

// Mask credential literals across a whole (possibly multi-line) code blob by
// applying maskCodeLine to each line. Splits on "\n" only so CRLF/CR endings
// are preserved byte-for-byte (the trailing "\r" rides along on each line and
// is untouched by maskCodeLine).
export function maskCode(code: string): string {
  return code.split("\n").map(maskCodeLine).join("\n");
}

// Mask credential values (PWD=…, UID=…, Password=…) inside a bare ODBC
// connection string (DataSource.oDBCConnection). Reuses maskCodeLine so the
// key=value masking stays in one regex; its other passes are no-ops on a
// conn string that isn't TI code.
export function maskConnectionString(conn: string): string {
  return maskCodeLine(conn);
}

// Deep-mask an arbitrary JSON-ish value: any object entry whose KEY name looks
// like a credential (isSecretName) has its value replaced with MASK; primitives
// stay as-is and nested objects/arrays are walked recursively. Used to sanitize
// raw config dumps (e.g. the full TM1 /Configuration object surfaced under
// `_raw`) before they leave the server, so a password sitting under
// Access.LDAP.Password or Access.Authentication.* never leaks unmasked.
export function maskSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => maskSecretsDeep(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretName(k) ? MASK : maskSecretsDeep(v);
    }
    return out;
  }
  return value;
}

// Copy of a TI datasource with the ODBC connection string's credential pairs
// masked. Structural generic so tool code can pass its own DataSource type
// without an import cycle. The password field is already redacted at the
// service layer (ProcessService.getDataSource), so only oDBCConnection needs
// handling here.
export function maskDataSourceSecrets<
  T extends { oDBCConnection?: string | undefined },
>(ds: T): T {
  if (ds.oDBCConnection === undefined) return ds;
  return { ...ds, oDBCConnection: maskConnectionString(ds.oDBCConnection) };
}
