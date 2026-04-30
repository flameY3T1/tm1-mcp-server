/**
 * Feature: tm1-mcp-server, Property 1: Konfigurations-Roundtrip
 *
 * For every valid combination of environment variables, loadConfig() produces a TM1Config
 * whose fields exactly match the set variables. For every incomplete combination (missing
 * required fields), loadConfig() throws an error.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import { loadConfig } from "../../src/config.js";

describe("Property 1: Konfigurations-Roundtrip", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TM1_")) delete process.env[key];
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("valid env vars produce correct TM1Config object", () => {
    const validLogLevels = ["debug", "info", "warn", "error"] as const;

    fc.assert(
      fc.property(
        fc.record({
          baseUrl: fc.webUrl(),
          user: fc.string({ minLength: 1, maxLength: 50 }),
          password: fc.string({ minLength: 1, maxLength: 50 }),
          rejectUnauthorized: fc.boolean(),
          keepAliveInterval: fc.integer({ min: 1000, max: 300000 }),
          requestTimeout: fc.integer({ min: 1000, max: 120000 }),
          logLevel: fc.constantFrom(...validLogLevels),
          logFile: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
        }),
        (env) => {
          // Clean TM1_ vars for this iteration
          Object.keys(process.env).forEach((key) => {
            if (key.startsWith("TM1_")) delete process.env[key];
          });

          process.env.TM1_BASE_URL = env.baseUrl;
          process.env.TM1_USER = env.user;
          process.env.TM1_PASSWORD = env.password;
          process.env.TM1_SSL_REJECT_UNAUTHORIZED = String(env.rejectUnauthorized);
          process.env.TM1_KEEP_ALIVE_INTERVAL = String(env.keepAliveInterval);
          process.env.TM1_REQUEST_TIMEOUT = String(env.requestTimeout);
          process.env.TM1_LOG_LEVEL = env.logLevel;
          if (env.logFile !== undefined) {
            process.env.TM1_LOG_FILE = env.logFile;
          } else {
            delete process.env.TM1_LOG_FILE;
          }

          const config = loadConfig();

          expect(config.baseUrl).toBe(env.baseUrl);
          expect(config.user).toBe(env.user);
          expect(config.password).toBe(env.password);
          expect(config.ssl.rejectUnauthorized).toBe(env.rejectUnauthorized);
          expect(config.keepAliveIntervalMs).toBe(env.keepAliveInterval);
          expect(config.requestTimeoutMs).toBe(env.requestTimeout);
          expect(config.logLevel).toBe(env.logLevel);
          if (env.logFile !== undefined) {
            expect(config.logFile).toBe(env.logFile);
          } else {
            expect(config.logFile).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("missing required fields throw an error", () => {
    fc.assert(
      fc.property(
        fc.record({
          hasBaseUrl: fc.boolean(),
          hasUser: fc.boolean(),
          hasPassword: fc.boolean(),
        }).filter((r) => !(r.hasBaseUrl && r.hasUser && r.hasPassword)),
        (flags) => {
          // Clean TM1_ vars for this iteration
          Object.keys(process.env).forEach((key) => {
            if (key.startsWith("TM1_")) delete process.env[key];
          });

          if (flags.hasBaseUrl) process.env.TM1_BASE_URL = "https://server:8010";
          if (flags.hasUser) process.env.TM1_USER = "admin";
          if (flags.hasPassword) process.env.TM1_PASSWORD = "secret";

          expect(() => loadConfig()).toThrow("Missing required environment variables");
        },
      ),
      { numRuns: 100 },
    );
  });
});
