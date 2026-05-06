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
  logFile?: string;
  tm1Version: string;
}

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

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
  };
}
