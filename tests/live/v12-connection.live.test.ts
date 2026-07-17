// Live S2S validation for the v12 (Planning Analytics Engine) connection
// profile: config → SessionManager → TM1Client → services. Exercises a real
// login (URL reroot + POST /{instance}/auth/v1/session) followed by two real
// service calls, against an actual PAE server.
//
// Opt-in: runs only when a v12 database is configured (TM1_INSTANCE +
// TM1_DATABASE). When absent, this suite self-skips — safe to run blind
// alongside the rest of the live suite.
//
//   TM1_BASE_URL=http://172.31.128.1:4444 TM1_INSTANCE=tm1 \
//   TM1_DATABASE=tm1_v12_test TM1_AUTH_MODE=s2s TM1_USER=admin \
//   TM1_CLIENT_ID=... TM1_CLIENT_SECRET=... npm run test:live
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SessionManager } from "../../src/session-manager.js";
import { TM1Client } from "../../src/tm1-client.js";
import { createLogger } from "../../src/logger.js";

const isV12 = Boolean(process.env.TM1_INSTANCE && process.env.TM1_DATABASE);

describe.skipIf(!isV12)("v12 S2S live connection", () => {
  it("authenticates and reads server info + cubes", async () => {
    const config = loadConfig();
    expect(config.version).toBe(12);

    const logger = createLogger({ logLevel: "error" });
    const sessionManager = new SessionManager(config, logger);
    const client = new TM1Client(config, sessionManager, logger);

    try {
      await client.connect();

      const info = await client.server.getInfo();
      expect(info.productVersion).toMatch(/\d+\.\d+/);

      const cubes = await client.cubes.list();
      expect(Array.isArray(cubes)).toBe(true);
      expect(cubes.length).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  });

  it("lists jobs (Activity) and rejects cancelling an unknown job", async () => {
    const config = loadConfig();
    const logger = createLogger({ logLevel: "error" });
    const sessionManager = new SessionManager(config, logger);
    const client = new TM1Client(config, sessionManager, logger);
    try {
      await client.connect();
      const jobs = await client.monitoring.getJobs();
      expect(Array.isArray(jobs)).toBe(true);
      // An idle server has no jobs; if any exist, they must be shape-valid.
      for (const j of jobs) {
        expect(typeof j.id).toBe("string");
        expect(typeof j.state).toBe("string");
      }
      await expect(
        client.monitoring.cancelJob("definitely-not-a-real-job-id"),
      ).rejects.toBeDefined();
    } finally {
      await client.disconnect();
    }
  });
});
