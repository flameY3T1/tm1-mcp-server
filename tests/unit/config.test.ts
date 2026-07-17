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

  it("should default namespace and camPassport to undefined", () => {
    setRequiredEnv();
    const config = loadConfig();
    expect(config.namespace).toBeUndefined();
    expect(config.camPassport).toBeUndefined();
  });

  it("should parse TM1_NAMESPACE for CAM auth", () => {
    setRequiredEnv();
    process.env.TM1_NAMESPACE = "LDAP";
    const config = loadConfig();
    expect(config.namespace).toBe("LDAP");
  });

  it("should treat empty TM1_NAMESPACE as unset", () => {
    setRequiredEnv();
    process.env.TM1_NAMESPACE = "";
    const config = loadConfig();
    expect(config.namespace).toBeUndefined();
  });

  it("should still require TM1_USER/TM1_PASSWORD in CAMNamespace mode", () => {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_NAMESPACE = "LDAP";
    expect(() => loadConfig()).toThrow(
      "Missing or empty required environment variables: TM1_USER, TM1_PASSWORD"
    );
  });

  it("should parse TM1_CAM_PASSPORT and not require user/password", () => {
    process.env.TM1_BASE_URL = "https://tm1server:8010";
    process.env.TM1_CAM_PASSPORT = "MTszMDk6...";
    const config = loadConfig();
    expect(config.camPassport).toBe("MTszMDk6...");
    expect(config.user).toBe("");
    expect(config.password).toBe("");
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

  it("should throw on non-numeric TM1_KEEP_ALIVE_INTERVAL", () => {
    setRequiredEnv();
    process.env.TM1_KEEP_ALIVE_INTERVAL = "abc";
    expect(() => loadConfig()).toThrow("Invalid TM1_KEEP_ALIVE_INTERVAL");
  });

  it("should throw on non-positive TM1_REQUEST_TIMEOUT", () => {
    setRequiredEnv();
    process.env.TM1_REQUEST_TIMEOUT = "0";
    expect(() => loadConfig()).toThrow("Invalid TM1_REQUEST_TIMEOUT");
  });

  it("should throw on non-numeric TM1_MCP_HTTP_PORT", () => {
    setRequiredEnv();
    process.env.TM1_MCP_HTTP_PORT = "NaN";
    expect(() => loadConfig()).toThrow("Invalid TM1_MCP_HTTP_PORT");
  });

  it("should set httpToken from TM1_MCP_HTTP_TOKEN", () => {
    setRequiredEnv();
    process.env.TM1_MCP_HTTP_TOKEN = "s3cret";
    expect(loadConfig().httpToken).toBe("s3cret");
  });

  it("should leave httpToken undefined when unset", () => {
    setRequiredEnv();
    expect(loadConfig().httpToken).toBeUndefined();
  });

  // Non-loopback HTTP bind without a bearer token would expose an
  // unauthenticated /mcp endpoint to the network — refuse at startup.
  describe("non-loopback HTTP bind requires TM1_MCP_HTTP_TOKEN", () => {
    it("throws for http transport on 0.0.0.0 without a token", () => {
      setRequiredEnv();
      process.env.TM1_MCP_TRANSPORT = "http";
      process.env.TM1_MCP_HTTP_HOST = "0.0.0.0";
      expect(() => loadConfig()).toThrow(/TM1_MCP_HTTP_TOKEN/);
    });

    it("throws for http transport on a LAN address without a token", () => {
      setRequiredEnv();
      process.env.TM1_MCP_TRANSPORT = "http";
      process.env.TM1_MCP_HTTP_HOST = "192.168.1.10";
      expect(() => loadConfig()).toThrow(/not loopback/);
    });

    it("allows a non-loopback bind when a token is set", () => {
      setRequiredEnv();
      process.env.TM1_MCP_TRANSPORT = "http";
      process.env.TM1_MCP_HTTP_HOST = "0.0.0.0";
      process.env.TM1_MCP_HTTP_TOKEN = "s3cret";
      expect(loadConfig().httpHost).toBe("0.0.0.0");
    });

    it("keeps warn-only behavior for loopback binds without a token", () => {
      setRequiredEnv();
      process.env.TM1_MCP_TRANSPORT = "http";
      for (const host of ["127.0.0.1", "127.0.0.2", "localhost", "::1"]) {
        process.env.TM1_MCP_HTTP_HOST = host;
        expect(loadConfig().httpHost).toBe(host);
      }
    });

    it("does not throw for stdio transport even with a non-loopback host set", () => {
      setRequiredEnv();
      process.env.TM1_MCP_HTTP_HOST = "0.0.0.0"; // stray var, http transport not selected
      expect(loadConfig().transport).toBe("stdio");
    });
  });

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
});
