import { defineConfig } from 'vitest/config';

// Live integration harness — exercises the real MCP tool layer against a
// running TM1 server. NOT part of `npm test` / `verify` (the default
// vitest.config.ts include does not list tests/live). Opt-in only:
//
//   TM1_BASE_URL=... TM1_USER=... TM1_PASSWORD=... npm run test:live
//
// Without TM1_BASE_URL the suites skip themselves (describe.skipIf), so this
// config is also safe to run blind in CI — it just reports skipped.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    globalSetup: ['tests/live/global-setup.ts'],
    // Live calls hit a real server: auth round-trip, OData, process compile.
    // Generous timeout; transaction-log style calls are deliberately avoided.
    testTimeout: 120000,
    hookTimeout: 120000,
    // One server, shared session, ordered lifecycles — run serially so the
    // sandbox namespace never races between files.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
