import { describe, it, expect } from "vitest";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";
import type { SessionManager } from "../../src/session-manager.js";
import type { TM1Config } from "../../src/config.js";

function cfg(version: 11 | 12): TM1Config {
  return {
    baseUrl: "http://host:4444",
    user: "admin",
    password: "",
    requestTimeoutMs: 30000,
    logLevel: "error",
    version,
  } as unknown as TM1Config;
}

describe("TM1Client.version", () => {
  const logger = createLogger({ logLevel: "error" } as unknown as TM1Config);
  const session = {} as unknown as SessionManager;

  it("reports 12 for a v12 config", () => {
    expect(new TM1Client(cfg(12), session, logger).version).toBe(12);
  });
  it("reports 11 for a v11 config", () => {
    expect(new TM1Client(cfg(11), session, logger).version).toBe(11);
  });
});
