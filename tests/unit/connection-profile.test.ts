import { describe, it, expect, vi } from "vitest";
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
      vi.unstubAllGlobals();
    }
  });
});
