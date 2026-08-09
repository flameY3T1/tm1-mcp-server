import { TM1Error, TM1ErrorCode } from "../../types.js";

/**
 * Transport/auth failures that must NEVER be swallowed by a fallback or
 * "feature not present" catch block. If one of these surfaces, the caller's
 * fallback path (e.g. v12 Files → v11 Blobs, $select downgrade, skip private
 * scope) would mask a real outage — returning empty/partial data as if the
 * server simply lacked the feature.
 */
const SYSTEMIC_CODES = new Set<TM1ErrorCode>([
  TM1ErrorCode.AUTH_FAILED,
  TM1ErrorCode.CONNECTION_FAILED,
  TM1ErrorCode.LOCK_TIMEOUT,
]);

/**
 * Guard for blanket fallback catch blocks. Rethrows systemic transport/auth
 * errors and any non-TM1Error (programming errors, unexpected throws); returns
 * for expected, handleable codes (NOT_FOUND / PERMISSION_DENIED / TM1_ERROR /
 * UNSUPPORTED_OPERATION / CONFLICT / VALIDATION_ERROR) so the existing
 * fallback or skip behavior is preserved.
 *
 * Usage:
 *   try { ...primary... }
 *   catch (e) { rethrowIfSystemic(e); ...fallback... }
 */
export function rethrowIfSystemic(e: unknown): void {
  if (e instanceof TM1Error && !SYSTEMIC_CODES.has(e.code)) return;
  throw e;
}

/**
 * Stricter variant for transaction-log windowing/probe paths: rethrows
 * everything `rethrowIfSystemic` does AND `PERMISSION_DENIED`. Here a permission
 * denial (e.g. cube-level security on a filtered query) must surface — swallowing
 * it would return an empty window that reads as "no transactions in range",
 * hiding the fact the caller simply cannot see the data. Use this instead of
 * `rethrowIfSystemic` wherever an empty result is otherwise indistinguishable
 * from "access denied".
 */
export function rethrowIfSystemicOrDenied(e: unknown): void {
  if (e instanceof TM1Error && e.code === TM1ErrorCode.PERMISSION_DENIED)
    throw e;
  rethrowIfSystemic(e);
}

/**
 * True when TM1 refused the SHAPE of the query rather than the request itself.
 *
 * This is a different axis from `rethrowIfSystemic*`, not a competing
 * classification: those two answer "may this error be swallowed at all?", this
 * one answers "is re-asking the same resource with a different OData query
 * even capable of helping?". Use it AFTER the systemic guard, never instead of
 * it.
 *
 * Only two answers qualify. TM1 rejects a `$select`/`$expand` it cannot parse
 * or does not implement with 400 (its catch-all for a malformed query option)
 * or 501; both land as `TM1_ERROR` because `classifyHttpError` only special-
 * cases 401/403/404/409. `UNSUPPORTED_OPERATION` is the same verdict raised by
 * our own version gates.
 *
 * Everything else is deliberately excluded. A 404 says the collection is not
 * there — no rewording of the query brings it back. A 500 is a server fault or
 * a transient, and retrying it three more times with broader queries just
 * multiplies the outage (see P7: four sequential full scans at ~30 s each).
 */
export function isUnsupportedQueryShape(e: unknown): boolean {
  if (!(e instanceof TM1Error)) return false;
  if (e.code === TM1ErrorCode.UNSUPPORTED_OPERATION) return true;
  return (
    e.code === TM1ErrorCode.TM1_ERROR &&
    (e.httpStatus === 400 || e.httpStatus === 501)
  );
}
