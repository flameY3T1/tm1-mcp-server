import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/property/**/*.property.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      // Baseline thresholds (2026-05-08): tests cover tm1-client + session
      // core; thin tool-wrapper modules pull the project total down to ~22%.
      // Set at-current floor to catch regressions; ratchet upward as tool-
      // level coverage gets added (medium-term target: lines/statements 50%).
      thresholds: {
        statements: 21,
        branches: 17,
        functions: 20,
        lines: 22,
      },
    },
    testTimeout: 30000,
  },
});
