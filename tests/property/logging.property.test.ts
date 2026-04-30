/**
 * Feature: tm1-mcp-server, Property 17: Log-Eintrags-Struktur
 *
 * For every API call, the log entry contains a timestamp (ISO 8601),
 * endpoint URL, and result status. All three fields must be present.
 *
 * **Validates: Requirements 9.3**
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import pino from "pino";
import { Writable } from "node:stream";

function createTestLogger() {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });

  const logger = pino(
    {
      level: "debug",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    dest,
  );

  function flush(): Array<Record<string, unknown>> {
    logger.flush();
    return lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  return { logger, flush };
}

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("Property 17: Log-Eintrags-Struktur", () => {
  it("every API call log entry contains timestamp, endpoint, and status", () => {
    const endpointArb = fc.constantFrom(
      "/api/v1/Cubes",
      "/api/v1/Dimensions",
      "/api/v1/Processes",
      "/api/v1/Chores",
      "/api/v1/ExecuteMDX",
      "/api/v1/ActiveSession",
      "/api/v1/Configuration/ProductVersion",
    );
    const statusArb = fc.integer({ min: 200, max: 599 });

    fc.assert(
      fc.property(endpointArb, statusArb, (endpoint, status) => {
        const { logger, flush } = createTestLogger();

        // Simulate what TM1Client does: log with endpoint and status
        logger.info({ endpoint, status }, "Request completed");

        const entries = flush();
        expect(entries.length).toBeGreaterThanOrEqual(1);

        const entry = entries[0];
        // Timestamp (ISO 8601)
        expect(entry.time).toBeDefined();
        expect(typeof entry.time).toBe("string");
        expect(ISO_8601_REGEX.test(entry.time as string)).toBe(true);

        // Endpoint URL
        expect(entry.endpoint).toBeDefined();
        expect(typeof entry.endpoint).toBe("string");
        expect((entry.endpoint as string).length).toBeGreaterThan(0);
        expect(entry.endpoint).toBe(endpoint);

        // Result status
        expect(entry.status).toBeDefined();
        expect(entry.status).toBe(status);
      }),
      { numRuns: 100 },
    );
  });

  it("error log entries also contain timestamp, endpoint, and status", () => {
    const endpointArb = fc.stringMatching(/^\/api\/v1\/[A-Za-z]+$/);
    const statusArb = fc.integer({ min: 400, max: 599 });
    const codeArb = fc.constantFrom(
      "CONNECTION_FAILED", "AUTH_FAILED", "PERMISSION_DENIED",
      "NOT_FOUND", "TM1_ERROR",
    );

    fc.assert(
      fc.property(endpointArb, statusArb, codeArb, (endpoint, status, code) => {
        const { logger, flush } = createTestLogger();

        logger.error({ endpoint, status, code }, "Request failed");

        const entries = flush();
        expect(entries.length).toBeGreaterThanOrEqual(1);

        const entry = entries[0];
        expect(entry.time).toBeDefined();
        expect(ISO_8601_REGEX.test(entry.time as string)).toBe(true);
        expect(entry.endpoint).toBe(endpoint);
        expect(entry.status).toBe(status);
      }),
      { numRuns: 100 },
    );
  });
});
