// Reviewed divergences between a fake and the recorded wire contracts.
//
// Shared by every guard (fetch-level, http-level, service-level) so a case is
// reviewed once and written down once. The reasoning behind the list lives in
// tests/fixtures/contract-exceptions.json itself.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContractException {
  endpoint: string;
  /** Payload path with array indices collapsed, e.g. `$.value[].Level`. */
  path: string;
  reason: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "fixtures", "contract-exceptions.json");

const { exceptions } = JSON.parse(readFileSync(FILE, "utf8")) as {
  exceptions: ContractException[];
};

export { exceptions };

/** `$.value[0].Parents[1].Name` → `$.value[].Parents[].Name` */
export function collapseIndices(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/**
 * True when this divergence has been reviewed and accepted.
 *
 * A path of `$.*` excuses every divergence at that endpoint. It exists for
 * tests whose whole point is a non-conforming payload (a $batch call answered
 * by a proxy page), where the offending keys differ per case and listing them
 * would pin the fixtures rather than the behaviour.
 */
export function isExcused(endpoint: string, problem: string): boolean {
  const path = collapseIndices(problem.split(":")[0] ?? "");
  return exceptions.some(
    (e) => e.endpoint === endpoint && (e.path === path || e.path === "$.*"),
  );
}
