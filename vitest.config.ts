import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Coverage floors live in coverage-thresholds.json so vitest and the ratchet
// gate (scripts/check-coverage-ratchet.mjs) enforce the exact same numbers.
// Read via fs rather than `import ... with { type: 'json' }` to keep this
// config loadable across the whole Node support matrix.
const here = dirname(fileURLToPath(import.meta.url));
const { floors } = JSON.parse(
  readFileSync(join(here, 'coverage-thresholds.json'), 'utf8'),
) as { floors: { statements: number; branches: number; functions: number; lines: number } };

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
      // Only first-party source counts. `include` already keeps tests/,
      // scripts/, dist/ and node_modules/ out; the explicit excludes drop what
      // has no meaningful behaviour to assert on:
      //   src/index.ts  — process entrypoint (arg parsing + wiring), exercised
      //                   by the live suite rather than unit tests
      //   **/*.d.ts     — type declarations, zero runtime
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.d.ts'],
      // text-summary keeps CI logs short (the ratchet gate prints the detail
      // table); json-summary is what scripts/check-coverage-ratchet.mjs reads;
      // html is the local drill-down report (coverage/ is gitignored).
      reporter: ['text-summary', 'json-summary', 'html'],
      // Hard floor — dropping below any of these fails the run. Raising them is
      // the ratchet; see the "Coverage Policy" section in README.md.
      thresholds: floors,
    },
    testTimeout: 30000,
  },
});
