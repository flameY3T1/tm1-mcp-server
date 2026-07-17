import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/logger.js";
import { Writable } from "node:stream";

/**
 * Helper: drive the REAL createLogger with an in-memory destination so masking,
 * timestamp and level behaviour are asserted against the production redact
 * config (not a hand-copied one). Deleting a field from redactPaths() in
 * src/logger.ts now fails these tests, as it should.
 */
function createTestLogger(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];

  const dest = new Writable({
    write(chunk, _encoding, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const logger = createLogger({ logLevel: level }, dest);

  function flush(): object[] {
    logger.flush();
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  return { logger, flush };
}

describe("Logger", () => {
  describe("createLogger", () => {
    it("should return a pino logger instance", () => {
      const logger = createLogger({ logLevel: "info" });
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.warn).toBe("function");
    });

    it("should respect the configured log level", () => {
      const logger = createLogger({ logLevel: "error" });
      expect(logger.level).toBe("error");
    });

    it("should accept all valid log levels", () => {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        const logger = createLogger({ logLevel: level });
        expect(logger.level).toBe(level);
      }
    });
  });

  describe("sensitive field masking", () => {
    it("should mask password field at top level", () => {
      const { logger, flush } = createTestLogger();
      logger.info({ password: "superSecret123" }, "login attempt");

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry.password).toBe("***");
      expect(JSON.stringify(entry)).not.toContain("superSecret123");
    });

    it("should mask Authorization header", () => {
      const { logger, flush } = createTestLogger();
      logger.info(
        { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
        "request"
      );

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      const headers = entry.headers as Record<string, unknown>;
      expect(headers.Authorization).toBe("***");
      expect(JSON.stringify(entry)).not.toContain("Basic dXNlcjpwYXNz");
    });

    it("should mask TM1SessionId", () => {
      const { logger, flush } = createTestLogger();
      logger.info(
        { TM1SessionId: "abc123sessiontoken" },
        "session established"
      );

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry.TM1SessionId).toBe("***");
      expect(JSON.stringify(entry)).not.toContain("abc123sessiontoken");
    });

    it("should mask nested sensitive fields", () => {
      const { logger, flush } = createTestLogger();
      logger.info(
        {
          request: {
            password: "nestedSecret",
            Authorization: "Bearer tok",
            TM1SessionId: "sess456",
          },
        },
        "nested data"
      );

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      const request = entry.request as Record<string, unknown>;
      expect(request.password).toBe("***");
      expect(request.Authorization).toBe("***");
      expect(request.TM1SessionId).toBe("***");
    });

    it("should mask v12 credential fields (clientSecret, accessToken, apiKey)", () => {
      const { logger, flush } = createTestLogger();
      logger.info(
        {
          config: {
            clientId: "public-client-id",
            clientSecret: "v12ClientSecret",
            accessToken: "v12AccessToken",
            apiKey: "v12ApiKey",
          },
        },
        "v12 config"
      );

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      const config = entry.config as Record<string, unknown>;
      expect(config.clientSecret).toBe("***");
      expect(config.accessToken).toBe("***");
      expect(config.apiKey).toBe("***");
      // clientId is a non-secret identifier and must NOT be masked
      expect(config.clientId).toBe("public-client-id");
      expect(JSON.stringify(entry)).not.toContain("v12ClientSecret");
      expect(JSON.stringify(entry)).not.toContain("v12AccessToken");
      expect(JSON.stringify(entry)).not.toContain("v12ApiKey");
    });

    it("should not mask non-sensitive fields", () => {
      const { logger, flush } = createTestLogger();
      logger.info(
        { endpoint: "/api/v1/Cubes", status: 200 },
        "api call"
      );

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry.endpoint).toBe("/api/v1/Cubes");
      expect(entry.status).toBe(200);
    });
  });

  describe("JSON output structure", () => {
    it("should produce JSON with ISO 8601 timestamp", () => {
      const { logger, flush } = createTestLogger();
      logger.info("test message");

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry.time).toBeDefined();
      // pino isoTime produces a string like "2024-01-01T00:00:00.000Z"
      expect(typeof entry.time).toBe("string");
      expect(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.time as string)
      ).toBe(true);
    });

    it("should include level and msg fields", () => {
      const { logger, flush } = createTestLogger();
      logger.info("hello world");

      const entries = flush();
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry.level).toBe(30); // pino info = 30
      expect(entry.msg).toBe("hello world");
    });
  });

  describe("log level filtering", () => {
    it("should not emit debug messages when level is info", () => {
      const { logger, flush } = createTestLogger("info");
      logger.debug("should be filtered");
      logger.info("should appear");

      const entries = flush();
      expect(entries.length).toBe(1);
      expect((entries[0] as Record<string, unknown>).msg).toBe("should appear");
    });
  });
});
