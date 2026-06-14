// Vitest globalSetup for the live suite. Vitest has no standalone
// "globalTeardown" option — the teardown is the `teardown` export of a
// globalSetup file (runs once after ALL test files, in a separate process).
//
// Each domain file already cleans up its own sandbox objects in afterAll; this
// teardown is the safety net that sweeps leftovers from a crashed/interrupted
// run. No-op when live is not configured.
import { getHarness, sweepSandbox, LIVE_ENABLED } from "./harness.js";

export function setup(): void {
  // Nothing to do up front — suites connect lazily via getHarness().
}

export async function teardown(): Promise<void> {
  if (!LIVE_ENABLED) return;
  try {
    const h = await getHarness();
    await sweepSandbox(h);
    await h.client.disconnect();
  } catch {
    /* best effort — nothing to clean or server already gone */
  }
}
