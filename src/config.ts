export interface TM1Config {
  baseUrl: string;
  user: string;
  password: string;
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
  // When "readonly", only READ_ONLY-annotated tools are registered. Write and
  // destructive tools are excluded entirely — they don't appear in the tool
  // listing. Default: "readwrite".
  mode: "readwrite" | "readonly";
}

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const VALID_TRANSPORTS = ["stdio", "http"] as const;
const VALID_MODES = ["readwrite", "readonly"] as const;

export function loadConfig(): TM1Config {
  const baseUrl = process.env.TM1_BASE_URL;
  const user = process.env.TM1_USER;
  const password = process.env.TM1_PASSWORD;

  // Required: baseUrl, user. Empty strings are rejected (treated as unset).
  // Password may be empty — some TM1 setups allow blank password for the admin
  // account or anonymous-style auth. We warn but don't block, so that the real
  // 401 from TM1 (if any) surfaces with context instead of an opaque error.
  const missing: string[] = [];
  if (!baseUrl) missing.push("TM1_BASE_URL");
  if (!user) missing.push("TM1_USER");
  if (password === undefined) missing.push("TM1_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required environment variables: ${missing.join(", ")}. ` +
        `Set them in your shell or .env file before starting the server.`,
    );
  }

  if (password === "") {
    process.stderr.write(
      "[tm1-mcp-server] WARNING: TM1_PASSWORD is empty. " +
        "If TM1 rejects with 401, check whether the account actually allows blank passwords.\n",
    );
  }

  const sslRaw = process.env.TM1_SSL_REJECT_UNAUTHORIZED;
  const rejectUnauthorized = sslRaw === undefined ? true : sslRaw !== "false";

  const keepAliveRaw = process.env.TM1_KEEP_ALIVE_INTERVAL;
  const keepAliveIntervalMs = keepAliveRaw ? parseInt(keepAliveRaw, 10) : 60000;

  const timeoutRaw = process.env.TM1_REQUEST_TIMEOUT;
  const requestTimeoutMs = timeoutRaw ? parseInt(timeoutRaw, 10) : 30000;

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
  const httpPortRaw = process.env.TM1_MCP_HTTP_PORT;
  const httpPort = httpPortRaw ? parseInt(httpPortRaw, 10) : 3000;

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

  const modeRaw = process.env.TM1_MODE ?? "readwrite";
  const mode = VALID_MODES.includes(modeRaw as (typeof VALID_MODES)[number])
    ? (modeRaw as TM1Config["mode"])
    : "readwrite";

  return {
    baseUrl: baseUrl!,
    user: user!,
    password: password!,
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
    mode,
  };
}
