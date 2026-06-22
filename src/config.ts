export interface TM1Config {
  baseUrl: string;
  user: string;
  password: string;
  // Optional CAM (Cognos Access Manager) namespace. When set, the client
  // authenticates with `Authorization: CAMNamespace base64(user:password:namespace)`
  // instead of native Basic auth. Mirrors TM1py's namespace-based CAM login.
  namespace?: string | undefined;
  // Optional pre-obtained CAM passport token. When set, takes precedence over
  // namespace/Basic and authenticates with `Authorization: CAMPassport <token>`.
  // Use when an external SSO/gateway step already produced the passport — the
  // server does no user/password round-trip in this mode.
  camPassport?: string | undefined;
  ssl: {
    rejectUnauthorized: boolean;
  };
  keepAliveIntervalMs: number;
  requestTimeoutMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logFile?: string | undefined;
  tm1Version: string;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  // Origin headers accepted by the Streamable HTTP transport when DNS-rebinding
  // protection is enabled. Defaults to loopback origins; extend via env when
  // serving from an explicit hostname.
  httpAllowedOrigins: string[];
  // Optional bearer token for the Streamable HTTP transport. When set, every
  // incoming /mcp request must carry `Authorization: Bearer <token>`. Unset
  // (default) means no transport-level auth — only safe behind loopback or a
  // trusted reverse proxy.
  httpToken?: string | undefined;
  // When "readonly", only READ_ONLY-annotated tools are registered. Write and
  // destructive tools are excluded entirely — they don't appear in the tool
  // listing. Default: "readonly" — write/destructive tools are opt-in via
  // TM1_MODE=readwrite, so an unconfigured server cannot mutate or delete TM1
  // objects by accident.
  mode: "readwrite" | "readonly";
}

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const VALID_TRANSPORTS = ["stdio", "http"] as const;
const VALID_MODES = ["readwrite", "readonly"] as const;

// Parse a positive-integer env var. Empty/unset → default. A non-numeric or
// non-positive value throws at startup instead of silently becoming NaN — NaN
// makes setInterval/setTimeout fire continuously and ports resolve to ":NaN".
function parseIntEnv(name: string, raw: string | undefined, def: number): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}". Expected a positive integer.`);
  }
  return n;
}

export function loadConfig(): TM1Config {
  const baseUrl = process.env.TM1_BASE_URL;
  const user = process.env.TM1_USER;
  const password = process.env.TM1_PASSWORD;

  // CAM auth (mirrors TM1py's RestService._build_authorization_token):
  //   TM1_CAM_PASSPORT set → "CAMPassport <token>"      (no user/password round-trip)
  //   TM1_NAMESPACE set     → "CAMNamespace b64(u:p:ns)" (needs user + password + namespace)
  //   neither               → "Basic b64(u:p)"           (native TM1)
  // SSO/gateway (Windows SSPI) is intentionally unsupported here: TM1py only does
  // it via the Windows-only requests_negotiate_sspi package. Supply a passport
  // obtained out-of-band via TM1_CAM_PASSPORT instead.
  const namespace = process.env.TM1_NAMESPACE || undefined;
  const camPassport = process.env.TM1_CAM_PASSPORT || undefined;

  // Required: baseUrl always. user/password only when NOT using a passport — a
  // passport carries the authenticated identity, so TM1 needs no credentials.
  // Empty strings are rejected (treated as unset). Password may be empty — some
  // TM1 setups allow a blank password for the admin account — so we warn but
  // don't block, letting the real 401 (if any) surface with context.
  const missing: string[] = [];
  if (!baseUrl) missing.push("TM1_BASE_URL");
  if (!camPassport) {
    if (!user) missing.push("TM1_USER");
    if (password === undefined) missing.push("TM1_PASSWORD");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required environment variables: ${missing.join(", ")}. ` +
        `Set them in your shell or .env file before starting the server.`,
    );
  }

  if (!camPassport && password === "") {
    process.stderr.write(
      "[tm1-mcp-server] WARNING: TM1_PASSWORD is empty. " +
        "If TM1 rejects with 401, check whether the account actually allows blank passwords.\n",
    );
  }

  const sslRaw = process.env.TM1_SSL_REJECT_UNAUTHORIZED;
  const rejectUnauthorized = sslRaw === undefined ? true : sslRaw !== "false";

  const keepAliveIntervalMs = parseIntEnv(
    "TM1_KEEP_ALIVE_INTERVAL",
    process.env.TM1_KEEP_ALIVE_INTERVAL,
    60000,
  );

  const requestTimeoutMs = parseIntEnv(
    "TM1_REQUEST_TIMEOUT",
    process.env.TM1_REQUEST_TIMEOUT,
    30000,
  );

  const logLevelRaw = process.env.TM1_LOG_LEVEL ?? "info";
  const logLevel = VALID_LOG_LEVELS.includes(logLevelRaw as typeof VALID_LOG_LEVELS[number])
    ? (logLevelRaw as TM1Config["logLevel"])
    : "info";

  const logFile = process.env.TM1_LOG_FILE || undefined;

  const tm1Version = process.env.TM1_VERSION || "11.8";

  const transportRaw = process.env.TM1_MCP_TRANSPORT ?? "stdio";
  const transport = VALID_TRANSPORTS.includes(transportRaw as typeof VALID_TRANSPORTS[number])
    ? (transportRaw as TM1Config["transport"])
    : "stdio";

  // Default to loopback. Binding to 0.0.0.0 must be opt-in to avoid exposing
  // a TM1-credentialed MCP server to the LAN by accident.
  const httpHost = process.env.TM1_MCP_HTTP_HOST || "127.0.0.1";
  const httpPort = parseIntEnv("TM1_MCP_HTTP_PORT", process.env.TM1_MCP_HTTP_PORT, 3000);

  // Origin allow-list for DNS-rebinding protection. Loopback origins are
  // always included so localhost dev clients work out of the box; if the
  // server binds to a non-loopback host we add http://<host>:<port> too.
  // TM1_MCP_HTTP_ALLOWED_ORIGINS (comma-separated) appends extras and is the
  // hook for HTTPS reverse-proxies / browser clients on a different origin.
  const defaultOrigins = [
    `http://127.0.0.1:${httpPort}`,
    `http://localhost:${httpPort}`,
  ];
  if (httpHost !== "127.0.0.1" && httpHost !== "localhost" && httpHost !== "0.0.0.0") {
    defaultOrigins.push(`http://${httpHost}:${httpPort}`);
  }
  const extraOriginsRaw = process.env.TM1_MCP_HTTP_ALLOWED_ORIGINS;
  const extraOrigins = extraOriginsRaw
    ? extraOriginsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const httpAllowedOrigins = Array.from(new Set([...defaultOrigins, ...extraOrigins]));

  const httpToken = process.env.TM1_MCP_HTTP_TOKEN || undefined;

  const modeRaw = process.env.TM1_MODE ?? "readonly";
  const mode = VALID_MODES.includes(modeRaw as (typeof VALID_MODES)[number])
    ? (modeRaw as TM1Config["mode"])
    : "readonly";

  return {
    baseUrl: baseUrl!,
    // In passport mode user/password are unused; default to "" so the type stays
    // a plain string and the Authorization header is built from the passport.
    user: user ?? "",
    password: password ?? "",
    namespace,
    camPassport,
    ssl: { rejectUnauthorized },
    keepAliveIntervalMs,
    requestTimeoutMs,
    logLevel,
    logFile,
    tm1Version,
    transport,
    httpHost,
    httpPort,
    httpAllowedOrigins,
    httpToken,
    mode,
  };
}
