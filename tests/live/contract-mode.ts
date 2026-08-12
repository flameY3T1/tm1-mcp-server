// Recording mode flags, split out from contract-recorder.ts on purpose.
//
// global-setup.ts needs to know whether a recording is in progress, but it
// runs OUTSIDE any test context, where calling `afterAll` throws. The recorder
// registers exactly such a hook, so importing it from global-setup crashes the
// run before a single test starts. Keeping the flags here lets both sides
// import what they need without dragging the hook along.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** One JSON line per observed response; merged after the suite finishes. */
export const SPOOL = join(here, "..", "fixtures", ".recorded.jsonl");

/** Same, for service-level (post-parsing) return shapes. */
export const SERVICE_SPOOL = join(
  here,
  "..",
  "fixtures",
  ".recorded-services.jsonl",
);

export const RECORDING = process.env.RECORD_CONTRACTS === "1";
