# TM1 v12 Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing ~120 tools work unchanged against a TM1 v12 (Planning Analytics Engine) database by adding a v12-aware connection/auth layer.

**Architecture:** One `ConnectionProfile` (built from config inside `SessionManager` and `TM1HttpClient`) owns two things — `resolveApiPath` (reroots `/api/v1/X` → `/{instance}/api/v1/Databases('{db}')/X` at the 6 URL-join points; the 192 service literals stay untouched) and `buildLoginRequest` (per-mode login descriptor). v12 login is `POST /{instance}/auth/v1/session` with `{"User":user}`; only the `Authorization` header varies per auth mode. Session cookie is `TM1SessionId` for both v11 and v12 (verified), so cookie parsing and the whole request/retry/re-auth path are unchanged.

**Tech Stack:** TypeScript (strict, exactOptionalPropertyTypes), Node/undici, Vitest, MCP SDK, pino.

## Global Constraints

- **Verify before done:** `npm run verify` (typecheck strict + lint:no-flat-api + lint:annotations + tests) must pass. CI runs the same.
- **Service composition:** no new flat-client REST methods; connection layer is transport-internal, not a service. Gate: `lint:no-flat-api`.
- **Strict output schemas:** no handler output changes in this plan (connection-only). If any added, list every field in the matching `src/tools/schemas/` schema (`additionalProperties:false`).
- **Secrets:** mask via `src/lib/mask-secrets.ts`; never log raw creds — log the auth mode label only.
- **Commits:** Conventional Commits; one logical change per task; no real customer/server names in tests or docs. Live S2S creds live only in a local `.env`, never committed.
- **v11 behavior must not change:** every existing unit/live test stays green; v11 is the `resolveApiPath` identity + existing login path.
- **Honesty:** S2S is live-validated; `basic`/`access_token`/`oidc`/`iam` are unit-only until a live target exists — CHANGELOG must say so.

---

### Task 1: Config — v12 env vars, detection, validation

**Files:**
- Modify: `src/config.ts` (interface `TM1Config`, function `loadConfig`)
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `TM1Config` gains fields:
  - `version: 11 | 12`
  - `instance?: string | undefined`, `database?: string | undefined`
  - `authMode?: "s2s" | "basic" | "access_token" | "oidc" | "iam" | undefined`
  - `clientId?: string | undefined`, `clientSecret?: string | undefined`
  - `accessToken?: string | undefined`
  - `apiKey?: string | undefined`, `iamUrl?: string | undefined`

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/config.test.ts` (mirror existing env-set/restore pattern in that file):

```ts
describe("v12 connection config", () => {
  it("stays version 11 when no instance/database set", () => {
    process.env.TM1_BASE_URL = "https://tm1:8010";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "secret";
    delete process.env.TM1_INSTANCE;
    delete process.env.TM1_DATABASE;
    const cfg = loadConfig();
    expect(cfg.version).toBe(11);
  });

  it("selects v12 s2s and parses instance/database/creds", () => {
    process.env.TM1_BASE_URL = "http://host:4444";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "";
    process.env.TM1_INSTANCE = "tm1";
    process.env.TM1_DATABASE = "db1";
    process.env.TM1_AUTH_MODE = "s2s";
    process.env.TM1_CLIENT_ID = "cid";
    process.env.TM1_CLIENT_SECRET = "csec";
    const cfg = loadConfig();
    expect(cfg.version).toBe(12);
    expect(cfg.instance).toBe("tm1");
    expect(cfg.database).toBe("db1");
    expect(cfg.authMode).toBe("s2s");
    expect(cfg.clientId).toBe("cid");
    expect(cfg.clientSecret).toBe("csec");
  });

  it("throws when instance set but database missing", () => {
    process.env.TM1_BASE_URL = "http://host:4444";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "x";
    process.env.TM1_INSTANCE = "tm1";
    delete process.env.TM1_DATABASE;
    expect(() => loadConfig()).toThrow(/TM1_DATABASE/);
  });

  it("throws when s2s mode missing client secret", () => {
    process.env.TM1_BASE_URL = "http://host:4444";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "x";
    process.env.TM1_INSTANCE = "tm1";
    process.env.TM1_DATABASE = "db1";
    process.env.TM1_AUTH_MODE = "s2s";
    process.env.TM1_CLIENT_ID = "cid";
    delete process.env.TM1_CLIENT_SECRET;
    expect(() => loadConfig()).toThrow(/TM1_CLIENT_SECRET/);
  });

  it("throws on unknown auth mode", () => {
    process.env.TM1_BASE_URL = "http://host:4444";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "x";
    process.env.TM1_INSTANCE = "tm1";
    process.env.TM1_DATABASE = "db1";
    process.env.TM1_AUTH_MODE = "banana";
    expect(() => loadConfig()).toThrow(/TM1_AUTH_MODE/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/config.test.ts -t "v12 connection config"`
Expected: FAIL (`version` undefined / no v12 parsing).

- [ ] **Step 3: Implement config parsing**

In `src/config.ts`, add fields to the `TM1Config` interface (after `namespace`/`camPassport` block):

```ts
  // v12 (Planning Analytics Engine). version===12 selects the v12 connection
  // profile (URL reroot + POST /{instance}/auth/v1/session login). Selected
  // when instance+database are set, or TM1_VERSION major is 12.
  version: 11 | 12;
  instance?: string | undefined;
  database?: string | undefined;
  authMode?: "s2s" | "basic" | "access_token" | "oidc" | "iam" | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  accessToken?: string | undefined;
  apiKey?: string | undefined;
  iamUrl?: string | undefined;
```

Add the valid-mode constant near the other `VALID_*` arrays:

```ts
const VALID_AUTH_MODES = ["s2s", "basic", "access_token", "oidc", "iam"] as const;
```

In `loadConfig`, after `tm1Version` is computed and before the `return`, insert:

```ts
  // --- v12 (Planning Analytics Engine) connection ---------------------------
  const instance = process.env.TM1_INSTANCE || undefined;
  const database = process.env.TM1_DATABASE || undefined;
  const versionMajor = Number.parseInt(tm1Version, 10);
  const isV12 = Boolean(instance || database) || versionMajor === 12;
  const version: 11 | 12 = isV12 ? 12 : 11;

  let authMode: TM1Config["authMode"];
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let accessToken: string | undefined;
  let apiKey: string | undefined;
  let iamUrl: string | undefined;

  if (version === 12) {
    if (!instance) {
      throw new Error("v12 connection requires TM1_INSTANCE (set alongside TM1_DATABASE).");
    }
    if (!database) {
      throw new Error("v12 connection requires TM1_DATABASE (set alongside TM1_INSTANCE).");
    }
    const modeRaw = (process.env.TM1_AUTH_MODE ?? "s2s").trim().toLowerCase();
    if (!VALID_AUTH_MODES.includes(modeRaw as (typeof VALID_AUTH_MODES)[number])) {
      throw new Error(
        `Invalid TM1_AUTH_MODE: "${process.env.TM1_AUTH_MODE}". ` +
          `Expected one of: ${VALID_AUTH_MODES.join(", ")}.`,
      );
    }
    authMode = modeRaw as TM1Config["authMode"];

    clientId = process.env.TM1_CLIENT_ID || undefined;
    clientSecret = process.env.TM1_CLIENT_SECRET || undefined;
    accessToken = process.env.TM1_ACCESS_TOKEN || undefined;
    apiKey = process.env.TM1_API_KEY || undefined;
    iamUrl = process.env.TM1_IAM_URL || undefined;

    const missingV12: string[] = [];
    if (authMode === "s2s") {
      if (!clientId) missingV12.push("TM1_CLIENT_ID");
      if (!clientSecret) missingV12.push("TM1_CLIENT_SECRET");
    } else if (authMode === "access_token" || authMode === "oidc") {
      if (!accessToken) missingV12.push("TM1_ACCESS_TOKEN");
    } else if (authMode === "iam") {
      if (!apiKey) missingV12.push("TM1_API_KEY");
      if (!iamUrl) missingV12.push("TM1_IAM_URL");
    }
    // authMode === "basic" reuses TM1_USER/TM1_PASSWORD, already validated above.
    if (missingV12.length > 0) {
      throw new Error(
        `TM1_AUTH_MODE="${authMode}" requires: ${missingV12.join(", ")}. ` +
          `Set them before starting the server.`,
      );
    }
  }
```

Add the new fields to the returned object literal:

```ts
    version,
    instance,
    database,
    authMode,
    clientId,
    clientSecret,
    accessToken,
    apiKey,
    iamUrl,
```

Note: the existing required-var check gates `TM1_USER`/`TM1_PASSWORD` unless `camPassport`. For v12 `s2s`/`access_token`/`iam`, `TM1_USER` is still required (it is the `{"User":…}` body); this is already enforced by the existing `missing` check, so no change needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS (all, incl. pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat(config): parse v12 connection env vars (instance/database/auth mode)"
```

---

### Task 2: Connection profile — `resolveApiPath`

**Files:**
- Create: `src/tm1-client/connection/profile.ts`
- Test: `tests/unit/connection-profile.test.ts`

**Interfaces:**
- Consumes: `TM1Config` (Task 1).
- Produces:
  ```ts
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
  export function createConnectionProfile(config: TM1Config): ConnectionProfile;
  ```
  (Task 2 implements `resolveApiPath` + the v11 branch of `buildLoginRequest`; Task 3 adds the v12 branch.)

- [ ] **Step 1: Write failing test**

Create `tests/unit/connection-profile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createConnectionProfile } from "../../src/tm1-client/connection/profile.js";
import type { TM1Config } from "../../src/config.js";

function baseConfig(overrides: Partial<TM1Config>): TM1Config {
  return {
    baseUrl: "http://host:4444",
    user: "admin",
    password: "",
    ssl: { rejectUnauthorized: true },
    keepAliveIntervalMs: 60000,
    requestTimeoutMs: 30000,
    logLevel: "info",
    tm1Version: "12",
    transport: "stdio",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    httpAllowedOrigins: [],
    mode: "readonly",
    version: 11,
    ...overrides,
  } as TM1Config;
}

describe("resolveApiPath", () => {
  it("is identity for v11", () => {
    const p = createConnectionProfile(baseConfig({ version: 11 }));
    expect(p.resolveApiPath("/api/v1/Cubes('x')")).toBe("/api/v1/Cubes('x')");
  });

  it("reroots v12 paths under the database", () => {
    const p = createConnectionProfile(
      baseConfig({ version: 12, instance: "tm1", database: "db1", authMode: "s2s", clientId: "c", clientSecret: "s" }),
    );
    expect(p.resolveApiPath("/api/v1/Cubes('x')")).toBe(
      "/tm1/api/v1/Databases('db1')/Cubes('x')",
    );
    expect(p.resolveApiPath("/api/v1/ActiveSession")).toBe(
      "/tm1/api/v1/Databases('db1')/ActiveSession",
    );
  });

  it("odata-escapes a database name with an apostrophe", () => {
    const p = createConnectionProfile(
      baseConfig({ version: 12, instance: "tm1", database: "d'b", authMode: "s2s", clientId: "c", clientSecret: "s" }),
    );
    expect(p.resolveApiPath("/api/v1/Cubes")).toBe("/tm1/api/v1/Databases('d''b')/Cubes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/connection-profile.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement profile with `resolveApiPath` + v11 login**

Create `src/tm1-client/connection/profile.ts`:

```ts
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

// v11 Authorization header (Basic / CAMNamespace / CAMPassport) — moved here
// from SessionManager.buildAuthorizationHeader so all login-header logic lives
// in one place.
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
    buildLoginRequest: async () => ({
      url: `${config.baseUrl}/api/v1/Configuration/ProductVersion`,
      method: "GET",
      headers: { Authorization: buildV11Authorization(config) },
    }),
  };
}
```

For this task, add a temporary v12 stub at the bottom so the file compiles (Task 3 replaces it):

```ts
function createV12Profile(config: TM1Config): ConnectionProfile {
  const instance = config.instance ?? "";
  const database = config.database ?? "";
  const dbRoot = `/${instance}/api/v1/Databases('${enc(database)}')`;
  return {
    resolveApiPath: (path) => path.replace(/^\/api\/v1/, dbRoot),
    buildLoginRequest: async () => {
      throw new Error("v12 login not implemented yet");
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/connection-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/connection/profile.ts tests/unit/connection-profile.test.ts
git commit -m "feat(connection): add ConnectionProfile with v11 login + v12 URL reroot"
```

---

### Task 3: Connection profile — v12 `buildLoginRequest` (all modes)

**Files:**
- Modify: `src/tm1-client/connection/profile.ts` (replace `createV12Profile`)
- Test: `tests/unit/connection-profile.test.ts` (add login cases)

**Interfaces:**
- Consumes: `TM1Config` (Task 1), `LoginRequest` (Task 2).
- Produces: v12 `buildLoginRequest()` returning a `POST {baseUrl}/{instance}/auth/v1/session` descriptor with `Content-Type: application/json`, body `{"User":<user>}`, and a mode-specific `Authorization` header. `iam` mode does a token pre-exchange.

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/connection-profile.test.ts`:

```ts
describe("v12 buildLoginRequest", () => {
  const v12 = (o: Partial<TM1Config>) =>
    createConnectionProfile(baseConfig({ version: 12, instance: "tm1", database: "db1", user: "admin", ...o }));

  it("s2s: POST session, Basic(client:secret), User body", async () => {
    const req = await v12({ authMode: "s2s", clientId: "cid", clientSecret: "csec" }).buildLoginRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://host:4444/tm1/auth/v1/session");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.headers.Authorization).toBe("Basic " + Buffer.from("cid:csec").toString("base64"));
    expect(req.body).toBe(JSON.stringify({ User: "admin" }));
  });

  it("basic (native): Basic(user:password)", async () => {
    const req = await v12({ authMode: "basic", password: "pw" }).buildLoginRequest();
    expect(req.headers.Authorization).toBe("Basic " + Buffer.from("admin:pw").toString("base64"));
    expect(req.body).toBe(JSON.stringify({ User: "admin" }));
  });

  it("access_token: Bearer <token>", async () => {
    const req = await v12({ authMode: "access_token", accessToken: "tok123" }).buildLoginRequest();
    expect(req.headers.Authorization).toBe("Bearer tok123");
  });

  it("oidc: Bearer <token>", async () => {
    const req = await v12({ authMode: "oidc", accessToken: "tok456" }).buildLoginRequest();
    expect(req.headers.Authorization).toBe("Bearer tok456");
  });

  it("iam: exchanges api_key for a bearer token", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "iam-tok" }),
      text: async () => "",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const req = await v12({ authMode: "iam", apiKey: "key", iamUrl: "https://iam/token" }).buildLoginRequest();
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://iam/token",
        expect.objectContaining({ method: "POST" }),
      );
      expect(req.headers.Authorization).toBe("Bearer iam-tok");
    } finally {
      vi.unstubAllMocks();
    }
  });
});
```

Add `vi` to the import at the top of the file: `import { describe, it, expect, vi } from "vitest";`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/connection-profile.test.ts -t "v12 buildLoginRequest"`
Expected: FAIL ("v12 login not implemented yet").

- [ ] **Step 3: Replace `createV12Profile`**

In `src/tm1-client/connection/profile.ts`, replace the stub `createV12Profile` with:

```ts
// IBM IAM api-key → access_token exchange (v12 iam mode). Mirrors TM1py's
// _generate_ibm_iam_cloud_access_token.
async function exchangeIamApiKey(apiKey: string, iamUrl: string): Promise<string> {
  const body =
    "grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=" +
    encodeURIComponent(apiKey);
  const response = await fetch(iamUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
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
      const token = await exchangeIamApiKey(config.apiKey ?? "", config.iamUrl ?? "");
      return `Bearer ${token}`;
    }
    default:
      throw new Error(`Unsupported v12 auth mode: ${String(config.authMode)}`);
  }
}

function createV12Profile(config: TM1Config): ConnectionProfile {
  const instance = config.instance ?? "";
  const database = config.database ?? "";
  const dbRoot = `/${instance}/api/v1/Databases('${enc(database)}')`;
  return {
    resolveApiPath: (path) => path.replace(/^\/api\/v1/, dbRoot),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/connection-profile.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/connection/profile.ts tests/unit/connection-profile.test.ts
git commit -m "feat(connection): v12 login descriptors for s2s/basic/access_token/oidc/iam"
```

---

### Task 4: SessionManager — use the connection profile

**Files:**
- Modify: `src/session-manager.ts`
- Test: `tests/unit/session-manager.test.ts`

**Interfaces:**
- Consumes: `createConnectionProfile` (Task 2/3), `ConnectionProfile.buildLoginRequest`, `resolveApiPath`.
- Produces: no signature change to `SessionManager` (still `constructor(config, logger?)`). Internally builds `this.profile = createConnectionProfile(config)`.

- [ ] **Step 1: Write failing test**

Add to `tests/unit/session-manager.test.ts` (uses the existing `makeConfig`/`mockFetchResponse` helpers — extend `makeConfig` to accept the new fields via its `Partial<TM1Config>` param, and add `version: 11` to its defaults object):

First, add `version: 11,` to the object returned by `makeConfig` (so the default config typechecks against the new interface). Then add:

```ts
it("v12 s2s: logs in via POST /{instance}/auth/v1/session with User body", async () => {
  const config = makeConfig({
    baseUrl: "http://host:4444",
    user: "admin",
    version: 12,
    instance: "tm1",
    database: "db1",
    authMode: "s2s",
    clientId: "cid",
    clientSecret: "csec",
  });
  const sm = new SessionManager(config, mockLogger);
  fetchSpy.mockResolvedValue(
    mockFetchResponse({ status: 201, setCookie: "TM1SessionId=jwt-abc; Path=/; HttpOnly" }),
  );

  const cookie = await sm.authenticate();

  expect(cookie).toBe("jwt-abc");
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("http://host:4444/tm1/auth/v1/session");
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ User: "admin" }));
  expect(init.headers.Authorization).toBe("Basic " + Buffer.from("cid:csec").toString("base64"));
});

it("v12 keepAlive targets the database-rooted ActiveSession", async () => {
  const config = makeConfig({
    baseUrl: "http://host:4444",
    version: 12,
    instance: "tm1",
    database: "db1",
    authMode: "s2s",
    clientId: "c",
    clientSecret: "s",
  });
  const sm = new SessionManager(config, mockLogger);
  fetchSpy.mockResolvedValue(
    mockFetchResponse({ status: 201, setCookie: "TM1SessionId=jwt; Path=/" }),
  );
  await sm.authenticate();
  fetchSpy.mockResolvedValue(mockFetchResponse({ ok: true, status: 200 }));
  await sm.keepAlive();
  const lastUrl = fetchSpy.mock.calls.at(-1)![0];
  expect(lastUrl).toBe("http://host:4444/tm1/api/v1/Databases('db1')/ActiveSession");
});
```

Note: the existing v11 login test asserts `mockFetchResponse` status 200; v12 returns 201. `doAuthenticate` currently only checks `response.ok` (both 200 and 201 are ok) — no change needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/session-manager.test.ts -t "v12"`
Expected: FAIL (login still GETs ProductVersion with Basic).

- [ ] **Step 3: Wire the profile into SessionManager**

In `src/session-manager.ts`:

Add import:
```ts
import { createConnectionProfile, type ConnectionProfile } from "./tm1-client/connection/profile.js";
```

Add a field + init in the constructor:
```ts
  private readonly profile: ConnectionProfile;
```
```ts
  constructor(config: TM1Config, logger?: pino.Logger) {
    this.config = config;
    this.logger = logger ?? createLogger(config);
    this.profile = createConnectionProfile(config);
  }
```

In `doAuthenticate`, replace the URL + `buildAuthorizationHeader()` + fetch block. Replace:
```ts
    const url = `${this.config.baseUrl}/api/v1/Configuration/ProductVersion`;
    const authorization = this.buildAuthorizationHeader();

    this.logger.info({ endpoint: url, authMode: this.authMode() }, "Authenticating with TM1");

    const response = await withTimeout(
      this.config.requestTimeoutMs,
      "Authentication",
      (signal) =>
        tm1Fetch(url, {
          method: "GET",
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          signal,
          dispatcher: getTm1Dispatcher(this.config),
        } as unknown as RequestInit),
    );
```
with:
```ts
    const loginReq = await this.profile.buildLoginRequest();

    this.logger.info({ endpoint: loginReq.url, authMode: this.authMode() }, "Authenticating with TM1");

    const response = await withTimeout(
      this.config.requestTimeoutMs,
      "Authentication",
      (signal) =>
        tm1Fetch(loginReq.url, {
          method: loginReq.method,
          headers: {
            ...loginReq.headers,
            Accept: "application/json",
            "User-Agent": USER_AGENT,
            "TM1-SessionContext": USER_AGENT,
            "TM1-Session-Context": USER_AGENT,
          },
          body: loginReq.body,
          signal,
          dispatcher: getTm1Dispatcher(this.config),
        } as unknown as RequestInit),
    );
```

In `keepAlive`, change the URL line:
```ts
    const url = `${this.config.baseUrl}/api/v1/ActiveSession`;
```
to:
```ts
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath("/api/v1/ActiveSession")}`;
```

In `logout`, change:
```ts
    const url = `${this.config.baseUrl}/api/v1/ActiveSession`;
```
to:
```ts
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath("/api/v1/ActiveSession")}`;
```

Update `authMode()` to report the v12 mode too (it is used for logging only):
```ts
  private authMode(): string {
    if (this.config.version === 12) return `v12:${this.config.authMode ?? "s2s"}`;
    if (this.config.camPassport) return "CAMPassport";
    if (this.config.namespace) return "CAMNamespace";
    return "Basic";
  }
```

Delete the now-unused `buildAuthorizationHeader` method (its logic moved to `profile.ts`). Remove its doc comment block too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/session-manager.test.ts`
Expected: PASS (all, incl. pre-existing v11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/session-manager.ts tests/unit/session-manager.test.ts
git commit -m "feat(session): drive login/keepalive/logout through ConnectionProfile"
```

---

### Task 5: http.ts — reroot request paths through the profile

**Files:**
- Modify: `src/tm1-client/http.ts`
- Test: `tests/unit/http-transport.test.ts`

**Interfaces:**
- Consumes: `createConnectionProfile` (Task 2/3), `resolveApiPath`.
- Produces: no signature change to `TM1HttpClient` (still `constructor(config, sessionManager, logger)`). Internally builds `this.profile = createConnectionProfile(config)`; all outbound URLs use `this.profile.resolveApiPath(path)`.

- [ ] **Step 1: Write failing test**

Add to `tests/unit/http-transport.test.ts` (follow the file's existing setup for constructing a `TM1HttpClient` with a mocked session + fetch; reuse its config factory, adding `version`/`instance`/`database`). Add:

```ts
it("v12: prefixes request paths with the database root", async () => {
  // Arrange a v12 client (config with version:12, instance:"tm1", database:"db1",
  // authMode:"s2s", clientId/clientSecret) and a session manager that returns a
  // fixed cookie, per this file's existing harness.
  // fetchSpy returns a 200 JSON body.
  await client.request("GET", "/api/v1/Cubes('Sales')");
  const url = fetchSpy.mock.calls.at(-1)![0];
  expect(url).toBe("http://host:4444/tm1/api/v1/Databases('db1')/Cubes('Sales')");
});
```

If `http-transport.test.ts` has no reusable v12 harness, add a focused `describe("v12 rerooting")` block that builds a `TM1HttpClient` the same way the existing tests do, only with the v12 config fields set and `baseUrl: "http://host:4444"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/http-transport.test.ts -t "v12"`
Expected: FAIL (URL is `http://host:4444/api/v1/Cubes('Sales')`, missing DB root).

- [ ] **Step 3: Wire the profile into TM1HttpClient**

In `src/tm1-client/http.ts`:

Add import:
```ts
import { createConnectionProfile, type ConnectionProfile } from "./connection/profile.js";
```

Add field + constructor init:
```ts
  private readonly profile: ConnectionProfile;
```
```ts
  constructor(
    config: TM1Config,
    sessionManager: SessionManager,
    logger: pino.Logger,
  ) {
    this.config = config;
    this.logger = logger;
    this.sessionManager = sessionManager;
    this.profile = createConnectionProfile(config);
  }
```

Reroot the three URL joins. In `request()` change the `url` construction (the line building `const url = ...${path}`) to:
```ts
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
```
In `requestRaw()`:
```ts
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
```
In `requestBinary()`:
```ts
    const url = `${this.config.baseUrl}${this.profile.resolveApiPath(path)}`;
```

(Each currently reads `` `${this.config.baseUrl}${path}` `` — replace `${path}` with `${this.profile.resolveApiPath(path)}`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/http-transport.test.ts`
Expected: PASS (all — v11 identity keeps existing URLs unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/tm1-client/http.ts tests/unit/http-transport.test.ts
git commit -m "feat(http): reroot request URLs through ConnectionProfile for v12"
```

---

### Task 6: Secret-masking regression for v12 credentials

**Files:**
- Test: `tests/unit/mask-secrets.test.ts`
- Modify (only if a test fails): `src/lib/mask-secrets.ts`

**Interfaces:**
- Consumes: `isSecretName`, `SECRET_NAME_RE` (existing).
- Produces: locked guarantee that `clientSecret`, `accessToken`, `apiKey` are treated as secret names; `clientId` is NOT masked (it is a non-secret identifier).

- [ ] **Step 1: Write test**

Add to `tests/unit/mask-secrets.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/unit/mask-secrets.test.ts -t "v12 credential names"`
Expected: PASS immediately — `SECRET_NAME_RE` already matches `secret`/`token`/`api[_-]?key`, and `clientId` matches none of the secret tokens. If any assertion fails, extend `SECRET_NAME_RE` in `src/lib/mask-secrets.ts` minimally to satisfy it, then re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/mask-secrets.test.ts src/lib/mask-secrets.ts
git commit -m "test(mask): lock v12 credential field masking (clientSecret/accessToken/apiKey)"
```

---

### Task 7: Live S2S validation

**Files:**
- Create: `tests/live/v12-connection.live.test.ts`

**Interfaces:**
- Consumes: the full stack (config → SessionManager → TM1Client → services).
- Produces: a live suite that self-skips unless v12 env vars are present, exercising login + two real service calls.

- [ ] **Step 1: Write the live test**

First grep the real method names so the calls compile:
```bash
grep -nE "async (getServerInfo|list|getAll)" src/tm1-client/services/server-service.ts src/tm1-client/services/cube-service.ts
```

Create `tests/live/v12-connection.live.test.ts` (mirror the skip-guard + client-construction pattern used by the other `tests/live/*.live.test.ts` files and `tests/live/global-setup.ts`):

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";

// Opt-in: runs only when a v12 database is configured.
//   TM1_BASE_URL=http://172.31.128.1:4444 TM1_INSTANCE=tm1 \
//   TM1_DATABASE=tm1_v12_test TM1_AUTH_MODE=s2s TM1_USER=admin \
//   TM1_CLIENT_ID=... TM1_CLIENT_SECRET=... npm run test:live
const isV12 = Boolean(process.env.TM1_INSTANCE && process.env.TM1_DATABASE);

describe.skipIf(!isV12)("v12 S2S live connection", () => {
  it("authenticates and reads server info + cubes", async () => {
    const config = loadConfig();
    expect(config.version).toBe(12);
    const logger = createLogger(config);
    const sm = new SessionManager(config, logger);
    const client = new TM1Client(config, sm, logger);

    const cookie = await sm.authenticate();
    expect(cookie.length).toBeGreaterThan(0);

    // Replace with the actual method names from the grep above.
    const info = await client.server.getServerInfo();
    expect(info).toBeTruthy();

    const cubes = await client.cubes.list();
    expect(Array.isArray(cubes)).toBe(true);

    await sm.logout();
  });
});
```

Adjust `client.server.getServerInfo()` / `client.cubes.list()` to the method names the grep reports (these are the only identifiers not defined in this plan, because they are pre-existing service methods).

- [ ] **Step 2: Run the live test against the real v12 server**

Create a local (git-ignored) `.env.v12` — never commit it:
```
TM1_BASE_URL=http://172.31.128.1:4444
TM1_INSTANCE=tm1
TM1_DATABASE=tm1_v12_test
TM1_AUTH_MODE=s2s
TM1_USER=admin
TM1_CLIENT_ID=<client id>
TM1_CLIENT_SECRET=<client secret>
```
Run: `set -a; . ./.env.v12; set +a; npx vitest run --config vitest.live.config.ts tests/live/v12-connection.live.test.ts`
Expected: PASS — authenticates, reads product version, lists cubes (7 on the test DB).

- [ ] **Step 3: Confirm `.env.v12` is ignored**

Run: `git check-ignore .env.v12 || echo "NOT IGNORED — add it to .gitignore"`
Expected: prints `.env.v12`. If not, add `.env.v12` to `.gitignore` and commit that line only.

- [ ] **Step 4: Commit**

```bash
git add tests/live/v12-connection.live.test.ts .gitignore
git commit -m "test(live): v12 S2S connection round-trip against real PAE server"
```

---

### Task 8: Docs + CHANGELOG

**Files:**
- Modify: `README.md` (env-var / connection section)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `.env.example` (if present — grep first)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Document v12 env vars**

In `README.md`, in the connection/configuration section, add a "TM1 v12 (Planning Analytics Engine)" subsection listing: `TM1_INSTANCE`, `TM1_DATABASE`, `TM1_AUTH_MODE` (`s2s|basic|access_token|oidc|iam`), and per-mode vars (`TM1_CLIENT_ID`/`TM1_CLIENT_SECRET`; `TM1_ACCESS_TOKEN`; `TM1_API_KEY`/`TM1_IAM_URL`). Note `TM1_BASE_URL` is address:port only for v12, and `TM1_USER` supplies the login `User`. State that v12 is auto-selected when `TM1_INSTANCE`+`TM1_DATABASE` are set.

- [ ] **Step 2: CHANGELOG entry (honest validation status)**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:
```markdown
- TM1 v12 (Planning Analytics Engine) connection support: URL rerooting under
  `/{instance}/api/v1/Databases('{database}')` and a `POST /{instance}/auth/v1/session`
  login. Auth modes: `s2s` (live-validated), and `basic`/`access_token`/`oidc`/`iam`
  (unit-validated request builders, not yet live-validated).
```

- [ ] **Step 3: Update `.env.example` if it exists**

Run: `ls .env.example 2>/dev/null && echo present || echo absent`
If present, append the v12 vars (with placeholder values, no real creds).

- [ ] **Step 4: Verify + commit**

Run: `npm run verify`
Expected: PASS (typecheck strict + lint gates + full unit suite).

```bash
git add README.md CHANGELOG.md .env.example
git commit -m "docs(v12): document v12 connection env vars and validation status"
```

---

## Self-Review

**Spec coverage:**
- URL reroot (spec §Architecture/1) → Task 2 (`resolveApiPath`) + Task 5 (http.ts) + Task 4 (session endpoints). ✓
- LoginStrategy per mode (spec §LoginStrategy) → Task 3. ✓
- Config surface + selection (spec §Config) → Task 1 (flat-optional variant; documented deviation, lower churn, matches CAM precedent). ✓
- SessionManager delegation (spec §SessionManager) → Task 4. ✓
- Secrets (spec §Secrets) → Task 6. ✓
- Testing unit + live + honesty (spec §Testing) → Tasks 1–6 (unit), 7 (live S2S), 8 (CHANGELOG honesty). ✓
- Out-of-scope Jobs/PAaaS/impersonation/refresh → not implemented, noted in Task 8 CHANGELOG scope. ✓

**Deviation from spec:** spec proposed a discriminated union on `version`; plan uses flat optional fields + `version: 11 | 12` to minimize churn and match the existing CAM pattern. Behaviorally identical; noted for the reviewer.

**Placeholder scan:** no TBD/TODO; every code step shows full code. Live-test method names (`server.getServerInfo`/`cubes.list`) flagged to grep-confirm in Task 7 Step 1 (the only names not defined in this plan, because they are pre-existing service methods).

**Type consistency:** `ConnectionProfile`/`LoginRequest`/`createConnectionProfile` names identical across Tasks 2–5. `resolveApiPath`/`buildLoginRequest` signatures stable. Config field names (`instance`,`database`,`authMode`,`clientId`,`clientSecret`,`accessToken`,`apiKey`,`iamUrl`,`version`) identical across Tasks 1, 3, 4, 5, 7.
