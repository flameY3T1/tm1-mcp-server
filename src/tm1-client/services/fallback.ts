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
