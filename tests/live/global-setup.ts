// Vitest globalSetup for the live suite. Vitest has no standalone
// "globalTeardown" option — the teardown is the `teardown` export of a
// globalSetup file (runs once after ALL test files, in a separate process).
//
// Each domain file already cleans up its own sandbox objects in afterAll; this
// teardown is the safety net that sweeps leftovers from a crashed/interrupted
// run. No-op when live is not configured.
import { rmSync } from "node:fs";
import { getHarness, sweepSandbox, LIVE_ENABLED } from "./harness.js";
import { RECORDING, SPOOL, SERVICE_SPOOL } from "./contract-mode.js";
import {
  mergeSpooledContracts,
  mergeSpooledServiceContracts,
} from "./merge-contracts.js";

export function setup(): void {
  // Suites connect lazily via getHarness(); the only up-front work is
  // discarding a spool left behind by an interrupted recording run, so its
  // shapes cannot leak into this one.
  if (RECORDING) {
    rmSync(SPOOL, { force: true });
    rmSync(SERVICE_SPOOL, { force: true });
  }
}

export async function teardown(): Promise<void> {
  if (!LIVE_ENABLED) return;
  try {
    const h = await getHarness();
    if (RECORDING) {
      // Version first — the contract file records what it was recorded
      // against, since v11 and v12 disagree on several shapes.
      const info = await h.client.server.getInfo();
      mergeSpooledContracts(info.productVersion || "unknown");
      mergeSpooledServiceContracts(info.productVersion || "unknown");
    }
    await sweepSandbox(h);
    await h.client.disconnect();
  } catch {
    /* best effort — nothing to clean or server already gone */
  }
}
