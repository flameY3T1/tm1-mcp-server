import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all TM1_ vars
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TM1_")) delete process.env[key];
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function setRequiredEnv() {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "secret";
  }

  it("should load config with all required env vars and defaults", () => {
    setRequiredEnv();
    const config = loadConfig();

    expect(config.baseUrl).toBe("https://tm1server:8010");
    expect(config.user).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.ssl.rejectUnauthorized).toBe(true);
    expect(config.keepAliveIntervalMs).toBe(60000);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.logLevel).toBe("info");
    expect(config.logFile).toBeUndefined();
  });

  it("should throw when TM1_BASE_URL is missing", () => {
    process.env.TM1_USER = "admin";
    process.env.TM1_PASSWORD = "secret";

    expect(() => loadConfig()).toThrow("Missing or empty required environment variables: TM1_BASE_URL");
  });

  it("should throw when TM1_USER is missing", () => {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_PASSWORD = "secret";

    expect(() => loadConfig()).toThrow("Missing or empty required environment variables: TM1_USER");
  });

  it("should throw when TM1_PASSWORD is missing", () => {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_USER = "admin";

    expect(() => loadConfig()).toThrow("Missing or empty required environment variables: TM1_PASSWORD");
  });

  it("should list all missing required fields in error", () => {
    expect(() => loadConfig()).toThrow(
      "Missing or empty required environment variables: TM1_BASE_URL, TM1_USER, TM1_PASSWORD"
    );
  });

  it("should parse TM1_SSL_REJECT_UNAUTHORIZED=false", () => {
    setRequiredEnv();
    process.env.TM1_SSL_REJECT_UNAUTHORIZED = "false";

    const config = loadConfig();
    expect(config.ssl.rejectUnauthorized).toBe(false);
  });

  it("should parse TM1_SSL_REJECT_UNAUTHORIZED=true", () => {
    setRequiredEnv();
    process.env.TM1_SSL_REJECT_UNAUTHORIZED = "true";

    const config = loadConfig();
    expect(config.ssl.rejectUnauthorized).toBe(true);
  });

  it("should parse custom keepAliveIntervalMs", () => {
    setRequiredEnv();
    process.env.TM1_KEEP_ALIVE_INTERVAL = "120000";

    const config = loadConfig();
    expect(config.keepAliveIntervalMs).toBe(120000);
  });

  it("should parse custom requestTimeoutMs", () => {
    setRequiredEnv();
    process.env.TM1_REQUEST_TIMEOUT = "5000";

    const config = loadConfig();
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it("should accept valid log levels", () => {
    setRequiredEnv();

    for (const level of ["debug", "info", "warn", "error"] as const) {
      process.env.TM1_LOG_LEVEL = level;
      const config = loadConfig();
      expect(config.logLevel).toBe(level);
    }
  });

  it("should default to 'info' for invalid log level", () => {
    setRequiredEnv();
    process.env.TM1_LOG_LEVEL = "verbose";

    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });

  it("should set logFile when TM1_LOG_FILE is provided", () => {
    setRequiredEnv();
    process.env.TM1_LOG_FILE = "/var/log/tm1-mcp.log";

    const config = loadConfig();
    expect(config.logFile).toBe("/var/log/tm1-mcp.log");
  });

  it("should leave logFile undefined when TM1_LOG_FILE is empty", () => {
    setRequiredEnv();
    process.env.TM1_LOG_FILE = "";

    const config = loadConfig();
    expect(config.logFile).toBeUndefined();
  });
});
