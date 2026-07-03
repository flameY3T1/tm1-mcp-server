/**
 * Feature: tm1-mcp-server, Property 11: Maskierung sensibler Daten
 *
 * For every log entry containing sensitive fields (passwords, tokens, auth headers),
 * those values must be masked. No plaintext sensitive data in the output.
 *
 * **Validates: Requirements 7.2, 9.4**
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Writable } from "node:stream";
import { createLogger } from "../../src/logger.js";

// Drive the REAL createLogger with an in-memory destination so the property
// holds against the production redact config, not a hand-copied duplicate.
function createTestLogger() {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const logger = createLogger({ logLevel: "debug" }, dest);

  function flush(): Array<Record<string, unknown>> {
    logger.flush();
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  return { logger, flush };
}

describe("Property 11: Maskierung sensibler Daten", () => {
  it("passwords in log entries are masked to ***", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
        (sensitivePassword) => {
          const { logger, flush } = createTestLogger();
          logger.info({ password: sensitivePassword }, "login attempt");
          const entries = flush();
          expect(entries.length).toBeGreaterThanOrEqual(1);
          expect(entries[0].password).toBe("***");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Authorization headers in log entries are masked to ***", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
        (authValue) => {
          const { logger, flush } = createTestLogger();
          logger.info({ headers: { Authorization: `Basic ${authValue}` } }, "request");
          const entries = flush();
          expect(entries.length).toBeGreaterThanOrEqual(1);
          const headers = entries[0].headers as Record<string, unknown>;
          expect(headers.Authorization).toBe("***");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("TM1SessionId tokens in log entries are masked to ***", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
        (sessionToken) => {
          const { logger, flush } = createTestLogger();
          logger.info({ TM1SessionId: sessionToken }, "session");
          const entries = flush();
          expect(entries.length).toBeGreaterThanOrEqual(1);
          expect(entries[0].TM1SessionId).toBe("***");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("nested sensitive fields are masked to ***", () => {
    fc.assert(
      fc.property(
        fc.record({
          password: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
          auth: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
          session: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0 && !s.includes("***")),
        }),
        (vals) => {
          const { logger, flush } = createTestLogger();
          logger.info({
            request: {
              password: vals.password,
              Authorization: vals.auth,
              TM1SessionId: vals.session,
            },
          }, "nested data");
          const entries = flush();
          expect(entries.length).toBeGreaterThanOrEqual(1);
          const request = entries[0].request as Record<string, unknown>;
          expect(request.password).toBe("***");
          expect(request.Authorization).toBe("***");
          expect(request.TM1SessionId).toBe("***");
        },
      ),
      { numRuns: 100 },
    );
  });
});
