import type { TM1Config } from "../../src/config.js";

/**
 * A complete, valid `TM1Config` for tests.
 *
 * Test files used to hand-roll partial config literals (baseUrl/user/password/
 * ssl/timeouts/logLevel and nothing else). That compiled only because `tests/`
 * was excluded from `tsc` — at runtime every later-added required field
 * (`tm1Version`, `transport`, `mode`, `responseMode`, `version`, the http*
 * fields) arrived as `undefined`. Spread this first and override only what the
 * test actually cares about:
 *
 * ```ts
 * function makeConfig(): TM1Config {
 *   return { ...baseTestConfig, requestTimeoutMs: 5000 };
 * }
 * ```
 *
 * The values mirror `loadConfig()` with no environment set, so a test using
 * this sees the same defaults a freshly started server would.
 */
export const baseTestConfig: TM1Config = {
  baseUrl: "https://tm1server:8010",
  user: "admin",
  password: "secret",
  ssl: { rejectUnauthorized: true },
  keepAliveIntervalMs: 60000,
  requestTimeoutMs: 30000,
  logLevel: "info",
  tm1Version: "11.8",
  transport: "stdio",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  httpAllowedOrigins: ["http://127.0.0.1:3000", "http://localhost:3000"],
  mode: "readonly",
  responseMode: "legacy",
  version: 11,
};

/** Convenience wrapper around {@link baseTestConfig} for call sites that build a config inline. */
export function makeTestConfig(overrides: Partial<TM1Config> = {}): TM1Config {
  return { ...baseTestConfig, ...overrides };
}
