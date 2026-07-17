// Connection profile: the v11↔v12 seam. Owns URL re-rooting and the login
// round-trip descriptor. Built from config inside SessionManager and
// TM1HttpClient. v11 = identity reroot + existing GET-ProductVersion login;
// v12 = database-rooted paths + POST /{instance}/auth/v1/session login.
import type { TM1Config } from "../../config.js";

export interface LoginRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface ConnectionProfile {
  resolveApiPath(path: string): string;
  buildLoginRequest(): Promise<LoginRequest>;
}

// OData single-quote escaping for a key segment (double the apostrophes),
// then URL-encode. Mirrors the `enc` helper used across the service layer.
const enc = (s: string): string => encodeURIComponent(String(s).replace(/'/g, "''"));

function buildBasicToken(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

// v11 Authorization header (Basic / CAMNamespace / CAMPassport). Lives here
// (rather than on SessionManager) so all login-header logic — v11 and v12 —
// is in one place.
function buildV11Authorization(config: TM1Config): string {
  const { user, password, namespace, camPassport } = config;
  if (camPassport) return `CAMPassport ${camPassport}`;
  if (namespace) {
    return "CAMNamespace " + Buffer.from(`${user}:${password}:${namespace}`).toString("base64");
  }
  return buildBasicToken(user, password);
}

export function createConnectionProfile(config: TM1Config): ConnectionProfile {
  if (config.version === 12) {
    // Implemented in Task 3.
    return createV12Profile(config);
  }

  return {
    resolveApiPath: (path) => path,
    buildLoginRequest: () =>
      Promise.resolve({
        url: `${config.baseUrl}/api/v1/Configuration/ProductVersion`,
        method: "GET",
        headers: { Authorization: buildV11Authorization(config) },
      }),
  };
}

// IBM IAM api-key → access_token exchange (v12 iam mode). Mirrors TM1py's
// _generate_ibm_iam_cloud_access_token. Bounded by timeoutMs so a hung IAM
// endpoint can't hang authenticate() forever.
async function exchangeIamApiKey(
  apiKey: string,
  iamUrl: string,
  timeoutMs: number,
): Promise<string> {
  const body =
    "grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=" +
    encodeURIComponent(apiKey);
  const response = await fetch(iamUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(timeoutMs ?? 30000),
  });
  if (!response.ok) {
    throw new Error(`IAM token exchange failed with status ${response.status}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error(`IAM token exchange returned no access_token from ${iamUrl}`);
  }
  return json.access_token;
}

// The Authorization header for a v12 login POST, by auth mode.
async function buildV12Authorization(config: TM1Config): Promise<string> {
  switch (config.authMode) {
    case "s2s":
      return "Basic " + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    case "basic":
      return buildBasicToken(config.user, config.password);
    case "access_token":
    case "oidc":
      return `Bearer ${config.accessToken}`;
    case "iam": {
      const token = await exchangeIamApiKey(
        config.apiKey ?? "",
        config.iamUrl ?? "",
        config.requestTimeoutMs,
      );
      return `Bearer ${token}`;
    }
    default:
      throw new Error(`Unsupported v12 auth mode: ${String(config.authMode)}`);
  }
}

function createV12Profile(config: TM1Config): ConnectionProfile {
  const instance = config.instance ?? "";
  const database = config.database ?? "";
  // encodeURIComponent (not `enc`) for the instance: it's a bare path segment,
  // not an OData quoted key — no apostrophe-doubling needed, just percent-encoding.
  const dbRoot = `/${encodeURIComponent(instance)}/api/v1/Databases('${enc(database)}')`;
  return {
    // Replacement FUNCTION, not a string: String.replace treats "$&"/"$$"/"$1"
    // in a string replacement specially, which would corrupt dbRoot if instance
    // or database contained a literal "$". A function return is used verbatim.
    resolveApiPath: (path) => path.replace(/^\/api\/v1/, () => dbRoot),
    buildLoginRequest: async () => ({
      url: `${config.baseUrl}/${instance}/auth/v1/session`,
      method: "POST",
      headers: {
        Authorization: await buildV12Authorization(config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ User: config.user }),
    }),
  };
}
