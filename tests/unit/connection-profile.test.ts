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
