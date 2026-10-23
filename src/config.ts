import { SANDBOX_PREFIX_PATTERN } from "./lib/sandbox-policy.js";

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
  //
  // "sandbox" sits between the two: the read tools plus the tools whose spec
  // is `sandboxScoped`, and those write only into a sandbox whose name starts
  // with `sandboxPrefix` — never into base data, never into a sandbox another
  // application of the same account owns. Publishing stays readwrite-only.
  mode: "readwrite" | "sandbox" | "readonly";
  // Name prefix of the sandboxes the server may create, write, discard and
  // delete in sandbox mode (TM1_SANDBOX_PREFIX, default "mcp-").
  sandboxPrefix: string;
  // How a successful tool result is put on the wire.
  //
  //   "legacy" (default) — the JSON body ships BOTH ways: as content[0].text and
  //                  as structuredContent. What the spec recommends: a tool
  //                  returning structured content SHOULD also return the
  //                  serialized JSON in a TextContent block.
  //   "structured" — structuredContent only; the text block is dropped. Halves
  //                  the wire bytes and is spec-legal precisely because an
  //                  outputSchema is declared (CallToolResult.content "may be
  //                  empty" then), but a client that reads content[0] and
  //                  ignores structuredContent sees NO OUTPUT.
  //
  // "legacy" is the default because the saving "structured" promises does not
  // exist on the clients that can read structuredContent: Claude Code
  // de-duplicates, so both-ways costs one copy of context, not two (measured
  // byte-identical tool_result at 1 KB and 23 KB). It is real only for clients
  // that serialize the entire CallToolResult into the prompt (Q DEV CLI / Kiro
  // CLI) — and those are never the ones that break. Meanwhile Kiro's IDE client
  // reads content[] exclusively, so "structured" renders as an empty result
  // there. Cost measured, benefit measured, default follows.
  responseMode: "legacy" | "structured";
  // v12 (Planning Analytics Engine). version===12 selects the v12 connection
  // profile (URL reroot + POST /{instance}/auth/v1/session login). Selected
  // when instance+database are set, or TM1_VERSION major is 12.
  version: 11 | 12;
  instance?: string | undefined;
  // PA SaaS tenant ID (authMode "saas"); replaces instance in the URL.
  tenant?: string | undefined;
  database?: string | undefined;
  authMode?:
    "s2s" | "basic" | "access_token" | "oidc" | "iam" | "saas" | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  accessToken?: string | undefined;
  apiKey?: string | undefined;
  iamUrl?: string | undefined;
}

const VALID_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const VALID_TRANSPORTS = ["stdio", "http"] as const;
const VALID_MODES = ["readwrite", "sandbox", "readonly"] as const;
const VALID_RESPONSE_MODES = ["legacy", "structured"] as const;
const VALID_AUTH_MODES = [
  "s2s",
  "basic",
  "access_token",
  "oidc",
  "iam",
  "saas",
] as const;

// Parse a positive-integer env var. Empty/unset → default. A non-numeric or
// non-positive value throws at startup instead of silently becoming NaN — NaN
// makes setInterval/setTimeout fire continuously and ports resolve to ":NaN".
function parseIntEnv(
  name: string,
  raw: string | undefined,
  def: number,
): number {
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

  // Which connection this is has to be known BEFORE the required-variable
  // check below, because the answer decides which credential is required.
  const tm1Version = process.env.TM1_VERSION || "11.8";
  const instance = process.env.TM1_INSTANCE || undefined;
  const database = process.env.TM1_DATABASE || undefined;
  const versionMajor = Number.parseInt(tm1Version, 10);
  // "saas" exists only on v12; without this a saas config missing
  // TM1_DATABASE would fall back to v11 and demand TM1_USER/TM1_PASSWORD.
  const isV12 =
    Boolean(instance || database) ||
    versionMajor === 12 ||
    process.env.TM1_AUTH_MODE?.trim().toLowerCase() === "saas";
  const version: 11 | 12 = isV12 ? 12 : 11;

  // Every v12 auth mode except "basic" authenticates with a client secret, a
  // bearer token or an API key, and the session login sends no password at all
  // (connection/profile.ts buildV12Authorization). Demanding TM1_PASSWORD there
  // rejects exactly the configuration docs/CONFIGURATION.md prescribes, and it
  // does so at startup, before the server can say anything more useful. The v12
  // block below still requires whichever credential the chosen mode does need.
  const v12AuthMode = (process.env.TM1_AUTH_MODE ?? "s2s").trim().toLowerCase();
  const passwordlessV12 = version === 12 && v12AuthMode !== "basic";
  // PA SaaS logs in as the fixed user "apikey" with TM1_API_KEY as password.
  const saas = version === 12 && v12AuthMode === "saas";
  const tenant = process.env.TM1_TENANT || undefined;

  // Required: baseUrl always. user/password only when NOT using a passport — a
  // passport carries the authenticated identity, so TM1 needs no credentials.
  // Empty strings are rejected (treated as unset). Password may be empty — some
  // TM1 setups allow a blank password for the admin account — so we warn but
  // don't block, letting the real 401 (if any) surface with context.
  const missing: string[] = [];
  if (!baseUrl) missing.push("TM1_BASE_URL");
  if (!camPassport) {
    if (!user && !saas) missing.push("TM1_USER");
    if (password === undefined && !passwordlessV12) {
      missing.push("TM1_PASSWORD");
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing or empty required environment variables: ${missing.join(", ")}. ` +
        `Set them in your shell or .env file before starting the server.`,
    );
  }

  if (!camPassport && !passwordlessV12 && password === "") {
    process.stderr.write(
      "[tm1-mcp-server] WARNING: TM1_PASSWORD is empty. " +
        "If TM1 rejects with 401, check whether the account actually allows blank passwords.\n",
    );
  }

  const sslRaw = process.env.TM1_SSL_REJECT_UNAUTHORIZED;
  const rejectUnauthorized = sslRaw === undefined ? true : sslRaw !== "false";
  if (!rejectUnauthorized && baseUrl?.startsWith("https:")) {
    process.stderr.write(
      "[tm1-mcp-server] WARNING: TM1_SSL_REJECT_UNAUTHORIZED=false — the TM1 " +
        "certificate is not verified, so credentials go to whoever answers on that address.\n",
    );
  }

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

  // Same parse shape as TM1_MODE: case-insensitive, an unknown value throws at
  // startup instead of silently falling back to the default.
  const logLevelRaw = (process.env.TM1_LOG_LEVEL ?? "info")
    .trim()
    .toLowerCase();
  if (
    !VALID_LOG_LEVELS.includes(logLevelRaw as (typeof VALID_LOG_LEVELS)[number])
  ) {
    throw new Error(
      `Invalid TM1_LOG_LEVEL: "${process.env.TM1_LOG_LEVEL}". Expected one of ${VALID_LOG_LEVELS.join(", ")}.`,
    );
  }
  const logLevel = logLevelRaw as TM1Config["logLevel"];

  const logFile = process.env.TM1_LOG_FILE || undefined;

  // A typo here used to start on stdio without a word: the expected /mcp port
  // never bound and the operator saw only a client that could not connect.
  const transportRaw = (process.env.TM1_MCP_TRANSPORT ?? "stdio")
    .trim()
    .toLowerCase();
  if (
    !VALID_TRANSPORTS.includes(
      transportRaw as (typeof VALID_TRANSPORTS)[number],
    )
  ) {
    throw new Error(
      `Invalid TM1_MCP_TRANSPORT: "${process.env.TM1_MCP_TRANSPORT}". Expected "stdio" or "http".`,
    );
  }
  const transport = transportRaw as TM1Config["transport"];

  // Default to loopback. Binding to 0.0.0.0 must be opt-in to avoid exposing
  // a TM1-credentialed MCP server to the LAN by accident.
  const httpHost = process.env.TM1_MCP_HTTP_HOST || "127.0.0.1";
  const httpPort = parseIntEnv(
    "TM1_MCP_HTTP_PORT",
    process.env.TM1_MCP_HTTP_PORT,
    3000,
  );

  // Origin allow-list for DNS-rebinding protection. Loopback origins are
  // always included so localhost dev clients work out of the box; if the
  // server binds to a non-loopback host we add http://<host>:<port> too.
  // TM1_MCP_HTTP_ALLOWED_ORIGINS (comma-separated) appends extras and is the
  // hook for HTTPS reverse-proxies / browser clients on a different origin.
  const defaultOrigins = [
    `http://127.0.0.1:${httpPort}`,
    `http://localhost:${httpPort}`,
  ];
  if (
    httpHost !== "127.0.0.1" &&
    httpHost !== "localhost" &&
    httpHost !== "0.0.0.0"
  ) {
    defaultOrigins.push(`http://${httpHost}:${httpPort}`);
  }
  const extraOriginsRaw = process.env.TM1_MCP_HTTP_ALLOWED_ORIGINS;
  const extraOrigins = extraOriginsRaw
    ? extraOriginsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const httpAllowedOrigins = Array.from(
    new Set([...defaultOrigins, ...extraOrigins]),
  );

  const httpToken = process.env.TM1_MCP_HTTP_TOKEN || undefined;

  // Refuse a non-loopback HTTP bind without transport auth: TM1_MCP_HTTP_HOST=0.0.0.0
  // (or any LAN address) with no bearer token would expose an unauthenticated,
  // TM1-credentialed /mcp endpoint to the network. Loopback binds keep the
  // warn-only behavior (see http-transport.ts).
  const hostLower = httpHost.toLowerCase();
  const isLoopbackHost =
    hostLower === "localhost" ||
    hostLower === "::1" ||
    /^127\./.test(hostLower);
  if (transport === "http" && !isLoopbackHost && !httpToken) {
    throw new Error(
      `TM1_MCP_HTTP_HOST="${httpHost}" is not loopback and TM1_MCP_HTTP_TOKEN is unset. ` +
        `Refusing to expose an unauthenticated /mcp endpoint beyond localhost — set ` +
        `TM1_MCP_HTTP_TOKEN, or bind to 127.0.0.1/localhost.`,
    );
  }

  // Case-insensitive so a `TM1_MODE=ReadWrite` typo resolves to readwrite rather
  // than silently falling back to readonly (dropping every write tool without a
  // word). A genuinely-unknown value throws at startup — parity with the numeric
  // env vars — instead of failing quietly.
  const modeRaw = (process.env.TM1_MODE ?? "readonly").trim().toLowerCase();
  if (!VALID_MODES.includes(modeRaw as (typeof VALID_MODES)[number])) {
    throw new Error(
      `Invalid TM1_MODE: "${process.env.TM1_MODE}". Expected "readwrite", "sandbox" or "readonly".`,
    );
  }
  const mode = modeRaw as TM1Config["mode"];

  // The prefix is what keeps sandbox mode off sandboxes it did not create, so
  // it may not be empty, and it must itself be a legal sandbox name.
  const sandboxPrefix = (process.env.TM1_SANDBOX_PREFIX ?? "mcp-").trim();
  if (sandboxPrefix === "" || !SANDBOX_PREFIX_PATTERN.test(sandboxPrefix)) {
    throw new Error(
      `Invalid TM1_SANDBOX_PREFIX: "${process.env.TM1_SANDBOX_PREFIX}". Use letters, digits, "-", "_" or "." (not empty).`,
    );
  }

  // Same parse shape as TM1_MODE: case-insensitive, unknown value throws at
  // startup rather than silently picking a wire format the operator did not ask
  // for.
  const responseModeRaw = (process.env.TM1_RESPONSE_MODE ?? "legacy")
    .trim()
    .toLowerCase();
  if (
    !VALID_RESPONSE_MODES.includes(
      responseModeRaw as (typeof VALID_RESPONSE_MODES)[number],
    )
  ) {
    throw new Error(
      `Invalid TM1_RESPONSE_MODE: "${process.env.TM1_RESPONSE_MODE}". Expected "legacy" or "structured".`,
    );
  }
  const responseMode = responseModeRaw as TM1Config["responseMode"];

  // --- v12 (Planning Analytics Engine) connection ---------------------------
  // Keep the DISPLAY string (server_info, logs) consistent with the numeric
  // `version`: a v12 connection (isV12, via TM1_INSTANCE/TM1_DATABASE) declared
  // with a v11-looking TM1_VERSION="11.8" would otherwise report "11.8" to users
  // while behaving as v12. Service branching keys off the numeric `version`
  // (the authoritative source of truth), so this coercion is cosmetic-only — it
  // stops the user-facing string from contradicting the real connection version.
  const effectiveTm1Version =
    isV12 && versionMajor !== 12 ? "12.0" : tm1Version;

  let authMode: TM1Config["authMode"];
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let accessToken: string | undefined;
  let apiKey: string | undefined;
  let iamUrl: string | undefined;

  if (version === 12) {
    if (saas && !tenant) {
      throw new Error(
        'TM1_AUTH_MODE="saas" requires TM1_TENANT (the PA SaaS tenant ID).',
      );
    }
    if (!instance && !saas) {
      throw new Error(
        "v12 connection requires TM1_INSTANCE (set alongside TM1_DATABASE).",
      );
    }
    if (!database) {
      throw new Error(
        "v12 connection requires TM1_DATABASE (set alongside TM1_INSTANCE).",
      );
    }
    const authModeRaw = v12AuthMode;
    if (
      !VALID_AUTH_MODES.includes(
        authModeRaw as (typeof VALID_AUTH_MODES)[number],
      )
    ) {
      throw new Error(
        `Invalid TM1_AUTH_MODE: "${process.env.TM1_AUTH_MODE}". ` +
          `Expected one of: ${VALID_AUTH_MODES.join(", ")}.`,
      );
    }
    authMode = authModeRaw as TM1Config["authMode"];

    clientId = process.env.TM1_CLIENT_ID || undefined;
    clientSecret = process.env.TM1_CLIENT_SECRET || undefined;
    accessToken = process.env.TM1_ACCESS_TOKEN || undefined;
    apiKey = process.env.TM1_API_KEY || undefined;
    iamUrl = process.env.TM1_IAM_URL || undefined;

    const missingV12: string[] = [];
    // Every v12 mode — not just "basic" — sends `{ User: config.user }` in the
    // session login body (profile.ts buildLoginRequest), so TM1_USER is required
    // regardless of authMode. For authMode === "basic" the v11 `missing` check
    // above (camPassport-gated) already pushed TM1_USER and threw before this
    // block runs when it's absent, so this only actually fires for the
    // non-basic modes — no duplicate report.
    if (!user && !saas) missingV12.push("TM1_USER");
    if (authMode === "s2s") {
      if (!clientId) missingV12.push("TM1_CLIENT_ID");
      if (!clientSecret) missingV12.push("TM1_CLIENT_SECRET");
    } else if (authMode === "access_token" || authMode === "oidc") {
      if (!accessToken) missingV12.push("TM1_ACCESS_TOKEN");
    } else if (authMode === "iam") {
      if (!apiKey) missingV12.push("TM1_API_KEY");
      if (!iamUrl) missingV12.push("TM1_IAM_URL");
    } else if (authMode === "saas") {
      if (!apiKey) missingV12.push("TM1_API_KEY");
    }
    if (missingV12.length > 0) {
      throw new Error(
        `TM1_AUTH_MODE="${authMode}" requires: ${missingV12.join(", ")}. ` +
          `Set them before starting the server.`,
      );
    }
  }

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
    tm1Version: effectiveTm1Version,
    transport,
    httpHost,
    httpPort,
    httpAllowedOrigins,
    httpToken,
    mode,
    sandboxPrefix,
    responseMode,
    version,
    instance,
    tenant,
    database,
    authMode,
    clientId,
    clientSecret,
    accessToken,
    apiKey,
    iamUrl,
  };
}
